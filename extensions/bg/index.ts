/**
 * pi-bg — long-running processes and external-condition waits.
 *
 * pi deliberately ships no background bash: a tool call runs to completion, so a dev server dies
 * with the turn that started it, and waiting for CI means a subagent burning an LLM turn per poll.
 * Both are process problems rather than agent problems, so they live here instead of inside a
 * subagent package.
 *
 * Nothing here blocks a turn. `bg_start` returns as soon as the child is spawned, and `bg_watch`
 * polls inside the extension and pushes the result back with `sendMessage`, which is what lets a
 * session carry on working while it waits.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOG_ROOT = path.join(os.tmpdir(), `pi-bg-${process.pid}`);
const DEFAULT_WATCH_INTERVAL_MS = 60_000;
const DEFAULT_WATCH_TIMEOUT_MS = 60 * 60_000;
/** Below this, polling an API like `gh` costs more in rate limit than it saves in latency. */
const MIN_WATCH_INTERVAL_MS = 5_000;
const SIGKILL_GRACE_MS = 5_000;
const LOG_TAIL_DEFAULT = 40;
/** Notifications are coalesced over this window so five things finishing is one turn, not five. */
const NUDGE_HOLD_MS = 1_500;

interface BgProcess {
	id: string;
	name: string;
	command: string;
	cwd: string;
	logFile: string;
	startedAt: number;
	exitedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	keepAlive: boolean;
	child: ChildProcess;
}

interface BgWatch {
	id: string;
	label: string;
	command: string;
	cwd: string;
	until?: string;
	intervalMs: number;
	deadline: number;
	startedAt: number;
	polls: number;
	lastPollAt: number;
	state: "watching" | "met" | "timeout" | "cancelled";
	lastOutput: string;
	timer?: ReturnType<typeof setInterval>;
}

const running = new Map<string, BgProcess>();
const watches = new Map<string, BgWatch>();

function shortId(): string {
	return randomUUID().slice(0, 8);
}

function ensureLogRoot(): void {
	fs.mkdirSync(LOG_ROOT, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else, which still counts as alive.
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Remove log directories belonging to pi processes that are gone.
 *
 * Shutdown cleanup alone is not enough: a killed process never runs it, and whether
 * `session_shutdown` reaches every kind of session is not something this extension should bet on.
 * Ownership is in the directory name, so liveness is the test — no age heuristic needed, and a
 * running session's logs are never touched.
 */
function sweepDeadLogRoots(): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const owner = /^pi-bg-(\d+)$/.exec(entry.name)?.[1];
		if (!owner || Number(owner) === process.pid || isProcessAlive(Number(owner))) continue;
		try {
			fs.rmSync(path.join(os.tmpdir(), entry.name), { recursive: true, force: true });
		} catch {
			/* another process may be removing it */
		}
	}
}

function isAlive(entry: BgProcess): boolean {
	return entry.exitedAt === undefined;
}

function elapsed(from: number, to = Date.now()): string {
	const seconds = Math.round((to - from) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function tailFile(file: string, lines: number): string {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "(no output yet)";
	}
	const all = text.split("\n").filter((line, index, arr) => line !== "" || index < arr.length - 1);
	return all.length <= lines ? all.join("\n") || "(no output yet)" : all.slice(-lines).join("\n");
}

function describeProcess(entry: BgProcess): string {
	const state = isAlive(entry)
		? `running ${elapsed(entry.startedAt)}`
		: `exited ${entry.signal ? entry.signal : entry.exitCode} after ${elapsed(entry.startedAt, entry.exitedAt)}`;
	const last = tailFile(entry.logFile, 1).split("\n").pop() ?? "";
	return `${entry.id}  ${entry.name}  ${state}\n  $ ${entry.command}\n  ${last.slice(0, 120)}`;
}

function describeWatch(watch: BgWatch): string {
	return `${watch.id}  ${watch.label}  ${watch.state}  ${watch.polls} polls over ${elapsed(watch.startedAt)}\n  $ ${watch.command}`;
}

/** Terminate a child, escalating only if it is still there. `killed` means "signal sent". */
function terminate(entry: BgProcess): void {
	if (!isAlive(entry)) return;
	entry.child.kill("SIGTERM");
	const escalate = setTimeout(() => {
		if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
	}, SIGKILL_GRACE_MS);
	escalate.unref?.();
	entry.child.once("exit", () => clearTimeout(escalate));
}

export default function (pi: ExtensionAPI) {
	sweepDeadLogRoots();
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Coalesce notifications per key: several watches finishing together should wake the session
	 * once, not once each. `followUp` waits for the current turn's tools to finish, and
	 * `triggerTurn` is what makes an idle session pick the result up instead of sitting on it.
	 */
	function notify(key: string, content: string) {
		const existing = pendingNudges.get(key);
		if (existing) clearTimeout(existing);
		pendingNudges.set(
			key,
			setTimeout(() => {
				pendingNudges.delete(key);
				pi.sendMessage({ customType: "pi-bg", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
			}, NUDGE_HOLD_MS),
		);
	}

	function runOnce(command: string, cwd: string): Promise<{ code: number | null; output: string }> {
		return new Promise((resolve) => {
			const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			const collect = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 64_000) output = output.slice(-64_000);
			};
			child.stdout?.on("data", collect);
			child.stderr?.on("data", collect);
			child.on("error", (error) => resolve({ code: null, output: `${output}\n${error.message}` }));
			child.on("close", (code) => resolve({ code, output }));
		});
	}

	pi.registerTool({
		name: "bg_start",
		label: "Start background process",
		description:
			"Start a long-running command that outlives this tool call — a dev server, a build watcher, a tunnel. Returns immediately with an id; output goes to a log you can tail with bg_logs.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session's" })),
			name: Type.Optional(Type.String({ description: "Label for listings; defaults to the first word of the command" })),
			keepAlive: Type.Optional(
				Type.Boolean({
					description:
						"Survive this pi session. Off by default: an orphaned server holding a port is harder to find than to restart.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ensureLogRoot();
			const id = shortId();
			const cwd = params.cwd ?? ctx.cwd;
			const logFile = path.join(LOG_ROOT, `${id}.log`);
			const out = fs.openSync(logFile, "a");
			const keepAlive = params.keepAlive === true;
			const child = spawn(params.command, {
				cwd,
				shell: true,
				detached: keepAlive,
				stdio: ["ignore", out, out],
			});
			if (keepAlive) child.unref();

			const entry: BgProcess = {
				id,
				name: params.name ?? params.command.trim().split(/\s+/)[0],
				command: params.command,
				cwd,
				logFile,
				startedAt: Date.now(),
				keepAlive,
				child,
			};
			running.set(id, entry);

			child.on("error", (error) => {
				entry.exitedAt = Date.now();
				entry.exitCode = null;
				fs.appendFileSync(logFile, `\n[pi-bg] failed to start: ${error.message}\n`);
				notify(`proc:${id}`, `Background process ${id} (${entry.name}) failed to start: ${error.message}`);
			});
			child.on("exit", (code, signal) => {
				entry.exitedAt = Date.now();
				entry.exitCode = code;
				entry.signal = signal;
				try {
					fs.closeSync(out);
				} catch {
					/* already closed */
				}
				// Only unexpected deaths are worth a turn; a process you stopped is not news.
				if (signal !== "SIGTERM" && signal !== "SIGKILL") {
					notify(
						`proc:${id}`,
						`Background process ${id} (${entry.name}) exited ${signal ?? code} after ${elapsed(entry.startedAt, entry.exitedAt)}.\nLast output:\n${tailFile(logFile, 10)}`,
					);
				}
			});

			return {
				content: [
					{
						type: "text",
						text: `Started ${id} (${entry.name})${keepAlive ? ", detached from this session" : ""}. Logs: bg_logs { id: "${id}" }.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List background work",
		description: "List background processes and watches started in this session.",
		parameters: Type.Object({}),
		async execute() {
			const lines = [...running.values()].map(describeProcess);
			const watchLines = [...watches.values()].map(describeWatch);
			if (lines.length === 0 && watchLines.length === 0) {
				return { content: [{ type: "text", text: "Nothing running." }] };
			}
			const sections = [
				lines.length > 0 ? `Processes:\n${lines.join("\n")}` : undefined,
				watchLines.length > 0 ? `Watches:\n${watchLines.join("\n")}` : undefined,
			].filter(Boolean);
			return { content: [{ type: "text", text: sections.join("\n\n") }] };
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Read background output",
		description: "Read the tail of a background process's output.",
		parameters: Type.Object({
			id: Type.String({ description: "Process id from bg_start" }),
			tail: Type.Optional(Type.Number({ description: `Lines to show; default ${LOG_TAIL_DEFAULT}` })),
		}),
		async execute(_id, params) {
			const entry = running.get(params.id);
			if (!entry) {
				const known = [...running.keys()].join(", ") || "none";
				return { content: [{ type: "text", text: `No process "${params.id}". Known: ${known}.` }], isError: true };
			}
			const tail = tailFile(entry.logFile, Math.max(1, params.tail ?? LOG_TAIL_DEFAULT));
			return { content: [{ type: "text", text: `${describeProcess(entry)}\n\n${tail}` }] };
		},
	});

	pi.registerTool({
		name: "bg_stop",
		label: "Stop background work",
		description: "Stop a background process, or cancel a watch, by id.",
		parameters: Type.Object({ id: Type.String({ description: "Process or watch id" }) }),
		async execute(_id, params) {
			const watch = watches.get(params.id);
			if (watch) {
				if (watch.timer) clearInterval(watch.timer);
				watch.state = watch.state === "watching" ? "cancelled" : watch.state;
				return { content: [{ type: "text", text: `Cancelled watch ${watch.id}.` }] };
			}
			const entry = running.get(params.id);
			if (!entry) {
				return { content: [{ type: "text", text: `No process or watch "${params.id}".` }], isError: true };
			}
			if (!isAlive(entry)) {
				return { content: [{ type: "text", text: `${entry.id} already exited.` }] };
			}
			terminate(entry);
			return { content: [{ type: "text", text: `Stopping ${entry.id} (${entry.name}).` }] };
		},
	});

	pi.registerTool({
		name: "bg_watch",
		label: "Watch for a condition",
		description: [
			"Poll a command until it succeeds, without blocking this turn and without spending a model turn per poll.",
			"Use it to wait on something outside the session: CI going green, a deploy settling, a port opening.",
			"Returns immediately; when the condition is met, fails, or times out, the session is told.",
		].join(" "),
		parameters: Type.Object({
			command: Type.String({ description: 'Shell command to poll, e.g. "gh pr checks --required"' }),
			until: Type.Optional(
				Type.String({
					description: "Regex the command's output must match. Omit to treat exit code 0 as the condition.",
				}),
			),
			intervalMs: Type.Optional(
				Type.Number({ description: `Poll interval; default ${DEFAULT_WATCH_INTERVAL_MS}, minimum ${MIN_WATCH_INTERVAL_MS}` }),
			),
			timeoutMs: Type.Optional(Type.Number({ description: `Give up after this long; default ${DEFAULT_WATCH_TIMEOUT_MS}` })),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session's" })),
			label: Type.Optional(Type.String({ description: "What you are waiting for, shown in listings and the notification" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			let pattern: RegExp | undefined;
			if (params.until !== undefined) {
				try {
					pattern = new RegExp(params.until);
				} catch (error) {
					return {
						content: [{ type: "text", text: `Invalid "until" regex: ${(error as Error).message}` }],
						isError: true,
					};
				}
			}

			const id = shortId();
			const intervalMs = Math.max(MIN_WATCH_INTERVAL_MS, params.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS);
			const watch: BgWatch = {
				id,
				label: params.label ?? "condition",
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				until: params.until,
				intervalMs,
				deadline: Date.now() + (params.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS),
				startedAt: Date.now(),
				polls: 0,
				lastPollAt: 0,
				state: "watching",
				lastOutput: "",
			};
			watches.set(id, watch);

			let polling = false;
			const finish = (state: BgWatch["state"], message: string) => {
				watch.state = state;
				if (watch.timer) clearInterval(watch.timer);
				notify(`watch:${id}`, message);
			};
			const poll = async () => {
				// A slow command must not stack up behind itself; skip rather than queue.
				if (polling || watch.state !== "watching") return;
				polling = true;
				try {
					watch.lastPollAt = Date.now();
					const { code, output } = await runOnce(watch.command, watch.cwd);
					watch.polls++;
					watch.lastOutput = output.slice(-4_000);
					const met = pattern ? pattern.test(output) : code === 0;
					if (met) {
						finish(
							"met",
							`Watch ${id} met after ${elapsed(watch.startedAt)}: ${watch.label}.\n$ ${watch.command}\n${output.slice(-1_500)}`,
						);
					} else if (Date.now() >= watch.deadline) {
						finish(
							"timeout",
							`Watch ${id} timed out after ${elapsed(watch.startedAt)} waiting for ${watch.label}.\nLast output:\n${output.slice(-1_500)}`,
						);
					}
				} finally {
					polling = false;
				}
			};

			// Check once immediately: the condition may already hold, and waiting a full interval to
			// discover that is the most annoying possible behaviour.
			await poll();

			// A session with no UI has no later. `-p` exits with its answer, so a notification
			// arrives after the process is gone — observed, not assumed. There the only place the
			// result can be delivered is this tool call, so wait in it.
			if (!ctx.hasUI) {
				while (watch.state === "watching") {
					if (signal?.aborted) {
						watch.state = "cancelled";
						return { content: [{ type: "text", text: `Watch ${id} aborted.` }], isError: true };
					}
					await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, 1_000)));
					if (Date.now() - watch.lastPollAt >= intervalMs) await poll();
				}
				watches.delete(id);
				const met = watch.state === "met";
				return {
					content: [
						{
							type: "text",
							text: met
								? `Watch met after ${elapsed(watch.startedAt)}: ${watch.label}.\n${watch.lastOutput.slice(-1_500)}`
								: `Watch timed out after ${elapsed(watch.startedAt)} waiting for ${watch.label}.\nLast output:\n${watch.lastOutput.slice(-1_500)}`,
						},
					],
					isError: !met,
				};
			}

			watch.timer = setInterval(() => void poll(), intervalMs);
			watch.timer.unref?.();

			return {
				content: [
					{
						type: "text",
						text: `Watching ${id}: ${watch.label}, every ${Math.round(intervalMs / 1000)}s. You will be told when it is met. Carry on with other work.`,
					},
				],
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const watch of watches.values()) if (watch.timer) clearInterval(watch.timer);
		watches.clear();
		let survivors = 0;
		for (const entry of running.values()) {
			// keepAlive is the whole point of keepAlive: leave those running.
			if (entry.keepAlive && isAlive(entry)) {
				survivors++;
				continue;
			}
			terminate(entry);
		}
		running.clear();
		// Logs of a process that is still running are still being written to; everything else is
		// scratch that would otherwise sit in /tmp forever.
		if (survivors === 0) {
			try {
				fs.rmSync(LOG_ROOT, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});
}
