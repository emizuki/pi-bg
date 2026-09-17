/**
 * pi-bg — long-running processes and external-condition waits.
 *
 * pi deliberately ships no background bash: a tool call runs to completion, so a dev server dies
 * with the turn that started it, and waiting for CI means a subagent burning an LLM turn per poll.
 * Both are process problems rather than agent problems, so they live here instead of inside a
 * subagent package.
 *
 * `bg_start` returns as soon as the child is spawned. `bg_watch` polls inside the extension, so
 * waiting never costs a model turn; in an interactive session it returns immediately and pushes
 * the outcome back with `sendMessage`, and in print/JSON modes — which have no later interactive
 * delivery channel — it waits inside the tool call instead.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOG_ROOT_PREFIX = path.join(os.tmpdir(), `pi-bg-${process.pid}-`);
let logRoot: string | undefined;
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
	/** Set by terminate(), so an exit we caused is distinguishable from one we did not. */
	stopping: boolean;
	logFd?: number;
	spawnError?: string;
	escalationTimer?: ReturnType<typeof setTimeout>;
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
	finishedAt?: number;
	state: "watching" | "met" | "timeout" | "cancelled" | "failed";
	lastOutput: string;
	outcome: string;
	notifyOnFinish: boolean;
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
	timer?: ReturnType<typeof setInterval>;
	deadlineTimer?: ReturnType<typeof setTimeout>;
}

const running = new Map<string, BgProcess>();
/** Exited entries are kept so bg_logs still works, but not forever. */
const MAX_REMEMBERED_EXITS = 20;

function pruneExited(): void {
	const exited = [...running.values()].filter((entry) => !isAlive(entry)).sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
	for (const entry of exited.slice(0, Math.max(0, exited.length - MAX_REMEMBERED_EXITS))) {
		running.delete(entry.id);
		try {
			fs.rmSync(entry.logFile, { force: true });
		} catch {
			/* ignore */
		}
	}
}
const watches = new Map<string, BgWatch>();

function shortId(): string {
	return randomUUID().slice(0, 8);
}

function ensureLogRoot(): string {
	if (logRoot !== undefined) return logRoot;
	logRoot = fs.mkdtempSync(LOG_ROOT_PREFIX);
	fs.chmodSync(logRoot, 0o700);
	return logRoot;
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
		const owner = /^pi-bg-(\d+)(?:-.+)?$/.exec(entry.name)?.[1];
		if (!owner || Number(owner) === process.pid || isProcessAlive(Number(owner))) continue;
		try {
			fs.rmSync(path.join(os.tmpdir(), entry.name), { recursive: true, force: true });
		} catch {
			/* another process may be removing it */
		}
	}
}

function isProcessGroupAlive(entry: BgProcess): boolean {
	const pid = entry.child.pid;
	if (pid === undefined) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function isAlive(entry: BgProcess): boolean {
	return entry.exitedAt === undefined || isProcessGroupAlive(entry);
}

function closeLog(entry: BgProcess): void {
	if (entry.logFd === undefined) return;
	try {
		fs.closeSync(entry.logFd);
	} catch {
		/* already closed */
	}
	entry.logFd = undefined;
}

function elapsed(from: number, to = Date.now()): string {
	const seconds = Math.round((to - from) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Read the tail of a log without loading the whole file.
 *
 * A dev server's log grows without bound; reading it whole on every `bg_list` is O(file), and past
 * V8's maximum string length it throws — which a bare catch would turn into "(no output yet)",
 * silently hiding a busy process's output rather than reporting a problem.
 */
const TAIL_BYTES = 64 * 1024;

interface BoundedOutput {
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}

function writePrivateSnapshot(prefix: string, content: string): string {
	const file = path.join(ensureLogRoot(), `${prefix}-${shortId()}.log`);
	fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return file;
}

function boundToolOutput(content: string, keep: "head" | "tail", fullOutputPath: () => string): BoundedOutput {
	const truncate = keep === "head" ? truncateHead : truncateTail;
	const probe = truncate(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!probe.truncated) return { text: content, truncated: false };

	const fullPath = fullOutputPath();
	let byteBudget = Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(fullPath) - 512);
	for (let attempt = 0; attempt < 4; attempt++) {
		const result = truncate(content, {
			maxBytes: byteBudget,
			maxLines: Math.max(1, DEFAULT_MAX_LINES - 4),
		});
		const suffix =
			`\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines ` +
			`(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). Full output saved to: ${fullPath}]`;
		const text = result.content + suffix;
		const overflow = Buffer.byteLength(text) - DEFAULT_MAX_BYTES;
		if (overflow <= 0 && text.split("\n").length <= DEFAULT_MAX_LINES) {
			return { text, truncated: true, fullOutputPath: fullPath };
		}
		byteBudget = Math.max(1, byteBudget - Math.max(64, overflow));
	}

	// The reserved metadata budget above is deliberately generous; this is a final safety net for
	// unusually long temporary paths rather than a normal path.
	const fallback = truncate(content, {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(fullPath) - 1_024),
		maxLines: Math.max(1, DEFAULT_MAX_LINES - 4),
	});
	return {
		text: `${fallback.content}\n\n[Output truncated. Full output saved to: ${fullPath}]`,
		truncated: true,
		fullOutputPath: fullPath,
	};
}

function tailFile(file: string, lines: number): string {
	let text: string;
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
		fs.readSync(fd, bytes, 0, bytes.length, start);
		text = bytes.toString("utf8");
		// A partial read can start mid-line; drop the fragment rather than show half a line.
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
	} catch {
		return "(no output yet)";
	} finally {
		if (fd !== undefined)
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
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
	// Against finishedAt, or a watch that met its condition in 30s reads as "over 4h" once the
	// session has been open that long.
	return `${watch.id}  ${watch.label}  ${watch.state}  ${watch.polls} polls over ${elapsed(watch.startedAt, watch.finishedAt)}\n  $ ${watch.command}`;
}

/**
 * Signal a child's whole process group.
 *
 * `shell: true` means the child is `/bin/sh -c "<command>"`, and sh only exec-optimises a command
 * with no shell operators. `cd app && npm run dev` therefore runs as a grandchild, and signalling
 * the shell alone leaves it reparented to init, still holding its port, while this extension
 * reports the entry as stopped. Every child is spawned `detached`, which puts it in its own group,
 * so a negative pid reaches the workload rather than only its wrapper.
 */
function signalChildGroup(child: ChildProcess, sig: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, sig);
	} catch {
		// Group already gone, or never created; fall back to the child itself.
		try {
			child.kill(sig);
		} catch {
			/* already dead */
		}
	}
}

function signalGroup(entry: BgProcess, sig: NodeJS.Signals): void {
	signalChildGroup(entry.child, sig);
}

/**
 * Terminate a child. `immediate` escalates without waiting, for shutdown: the grace period runs on
 * a timer, and a synchronous shutdown handler in an exiting process never reaches it.
 */
function terminate(entry: BgProcess, immediate = false): void {
	if (immediate) {
		if (!isAlive(entry)) return;
		entry.stopping = true;
		if (entry.escalationTimer) clearTimeout(entry.escalationTimer);
		entry.escalationTimer = undefined;
		// Shutdown must override an earlier graceful stop. The shell leader may already be gone
		// while descendants remain in its process group.
		signalGroup(entry, "SIGKILL");
		return;
	}
	if (!isAlive(entry) || entry.stopping) return;
	entry.stopping = true;
	signalGroup(entry, "SIGTERM");
	entry.escalationTimer = setTimeout(() => {
		entry.escalationTimer = undefined;
		if (isAlive(entry)) signalGroup(entry, "SIGKILL");
		pruneExited();
	}, SIGKILL_GRACE_MS);
	entry.escalationTimer.unref?.();
}

export default function (pi: ExtensionAPI) {
	sweepDeadLogRoots();
	let active = true;

	/**
	 * Coalesce notifications per key: several watches finishing together should wake the session
	 * once, not once each. `followUp` waits for the current turn's tools to finish, and
	 * `triggerTurn` is what makes an idle session pick the result up instead of sitting on it.
	 */
	let pendingLines: string[] = [];
	let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

	/** Collect notifications into one wake-up while this extension instance still owns the session. */
	function notify(content: string): void {
		if (!active) return;
		pendingLines.push(content);
		if (nudgeTimer) clearTimeout(nudgeTimer);
		nudgeTimer = setTimeout(() => {
			nudgeTimer = undefined;
			const body = pendingLines.join("\n\n");
			pendingLines = [];
			if (!active || body === "") return;
			try {
				pi.sendMessage({ customType: "pi-bg", content: body, display: true }, { deliverAs: "followUp", triggerTurn: true });
			} catch {
				/* the session may have been replaced between the active check and delivery */
			}
		}, NUDGE_HOLD_MS);
		nudgeTimer.unref?.();
	}

	function settleWatch(
		watch: BgWatch,
		state: Exclude<BgWatch["state"], "watching">,
		message: string,
		announce = watch.notifyOnFinish,
	): boolean {
		if (watch.state !== "watching") return false;
		watch.state = state;
		watch.finishedAt = Date.now();
		watch.outcome = message;
		if (watch.timer) clearInterval(watch.timer);
		if (watch.deadlineTimer) clearTimeout(watch.deadlineTimer);
		watches.delete(watch.id);
		watch.controller.abort();
		watch.resolveDone();
		if (announce) notify(message);
		return true;
	}

	/** Run one poll command with both a per-poll cap and owner-driven cancellation. */
	function runOnce(
		command: string,
		cwd: string,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<{ code: number | null; output: string }> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Poll aborted."));
				return;
			}
			let child: ChildProcess;
			try {
				child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				reject(error);
				return;
			}
			const abort = () => signalChildGroup(child, "SIGKILL");
			signal.addEventListener("abort", abort, { once: true });
			const cap = setTimeout(abort, Math.max(1, timeoutMs));
			cap.unref?.();
			const cleanup = () => {
				clearTimeout(cap);
				signal.removeEventListener("abort", abort);
			};
			let output = "";
			const collect = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 64_000) output = output.slice(-64_000);
			};
			child.stdout?.on("data", collect);
			child.stderr?.on("data", collect);
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("close", (code) => {
				cleanup();
				resolve({ code, output });
			});
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
			// `cmd &` makes sh exit 0 at once, so the entry is marked exited while the real work is
			// untracked and unstoppable. Validate before opening a log so rejection cannot leak an fd.
			if (/&\s*$/.test(params.command.trim())) {
				throw new Error(
					"Drop the trailing '&': bg_start already runs the command in the background, and a self-backgrounding command exits immediately, leaving the real process untracked.",
				);
			}
			const root = ensureLogRoot();
			const id = shortId();
			// Resolved against the session's cwd, which is what the parameter description promises;
			// spawn would otherwise resolve a relative path against pi's own process cwd.
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const logFile = path.join(root, `${id}.log`);
			const out = fs.openSync(logFile, "ax", 0o600);
			fs.fchmodSync(out, 0o600);
			const keepAlive = params.keepAlive === true;
			let child: ChildProcess;
			try {
				child = spawn(params.command, {
					cwd,
					shell: true,
					// Always its own process group, so terminate() can reach a grandchild. unref always
					// too: a background process must never be the reason pi cannot exit.
					detached: true,
					stdio: ["ignore", out, out],
				});
			} catch (error) {
				try {
					fs.closeSync(out);
				} finally {
					fs.rmSync(logFile, { force: true });
				}
				throw error;
			}
			child.unref();

			const entry: BgProcess = {
				id,
				name: params.name ?? params.command.trim().split(/\s+/)[0],
				command: params.command,
				cwd,
				logFile,
				startedAt: Date.now(),
				keepAlive,
				stopping: false,
				logFd: out,
				child,
			};
			running.set(id, entry);
			pruneExited();

			child.on("error", (error) => {
				entry.exitedAt ??= Date.now();
				entry.exitCode = null;
				entry.spawnError = error.message;
				closeLog(entry);
				try {
					fs.appendFileSync(logFile, `\n[pi-bg] failed to start: ${error.message}\n`);
				} catch {
					/* shutdown may already have removed the scratch log */
				}
				notify(`Background process ${id} (${entry.name}) failed to start: ${error.message}`);
			});
			// `close` rather than `exit`: a spawn that fails emits error and close but never exit, so
			// closing the log there leaked a descriptor on every failed start.
			child.on("close", (code, signal) => {
				entry.exitedAt ??= Date.now();
				if (entry.exitCode === undefined) entry.exitCode = code;
				entry.signal = signal;
				closeLog(entry);
				// Keyed on whether we asked for it, not on which signal arrived: an OOM kill or a
				// `kill` from another terminal is exactly the unexpected death worth reporting.
				if (!entry.spawnError && !entry.stopping && code !== null) {
					notify(
						`Background process ${id} (${entry.name}) exited ${signal ?? code} after ${elapsed(entry.startedAt, entry.exitedAt)}.\nLast output:\n${tailFile(logFile, 10)}`,
					);
				} else if (!entry.spawnError && !entry.stopping && signal) {
					notify(
						`Background process ${id} (${entry.name}) was killed by ${signal} after ${elapsed(entry.startedAt, entry.exitedAt)}.\nLast output:\n${tailFile(logFile, 10)}`,
					);
				}
				pruneExited();
			});

			return {
				content: [
					{
						type: "text",
						text: `Started ${id} (${entry.name})${keepAlive ? ", detached from this session" : ""}. Logs: bg_logs { id: "${id}" }.`,
					},
				],
				details: { id, name: entry.name, cwd, logFile, keepAlive },
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List background work",
		description: "List background processes and active watches started in this session. Output is capped at 50KB/2000 lines.",
		parameters: Type.Object({}),
		async execute() {
			const lines = [...running.values()].map(describeProcess);
			const watchLines = [...watches.values()].map(describeWatch);
			if (lines.length === 0 && watchLines.length === 0) {
				return {
					content: [{ type: "text", text: "Nothing running." }],
					details: { truncated: false, fullOutputPath: undefined as string | undefined },
				};
			}
			const sections = [
				lines.length > 0 ? `Processes:\n${lines.join("\n")}` : undefined,
				watchLines.length > 0 ? `Watches:\n${watchLines.join("\n")}` : undefined,
			].filter(Boolean);
			const raw = sections.join("\n\n");
			const output = boundToolOutput(raw, "head", () => writePrivateSnapshot("list", raw));
			return {
				content: [{ type: "text", text: output.text }],
				details: { truncated: output.truncated, fullOutputPath: output.fullOutputPath },
			};
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Read background output",
		description: "Read the tail of a background process's output, capped at 50KB/2000 lines.",
		parameters: Type.Object({
			id: Type.String({ description: "Process id from bg_start" }),
			tail: Type.Optional(Type.Number({ description: `Lines to show; default ${LOG_TAIL_DEFAULT}` })),
		}),
		async execute(_id, params) {
			const entry = running.get(params.id);
			if (!entry) {
				const known = [...running.keys()].join(", ") || "none";
				throw new Error(`No process "${params.id}". Known: ${known}.`);
			}
			const requestedTail = Math.max(1, params.tail ?? LOG_TAIL_DEFAULT);
			const tail = tailFile(entry.logFile, requestedTail);
			const raw = `${describeProcess(entry)}\n\n${tail}`;
			const output = boundToolOutput(raw, "tail", () => entry.logFile);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					id: entry.id,
					logFile: entry.logFile,
					tail: requestedTail,
					truncated: output.truncated,
					fullOutputPath: output.fullOutputPath,
				},
			};
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
				settleWatch(watch, "cancelled", `Watch ${watch.id} cancelled.`, false);
				return {
					content: [{ type: "text", text: `Cancelled watch ${watch.id}.` }],
					details: { id: watch.id, kind: "watch", state: watch.state },
				};
			}
			const entry = running.get(params.id);
			if (!entry) {
				throw new Error(`No process or watch "${params.id}".`);
			}
			if (!isAlive(entry)) {
				return {
					content: [{ type: "text", text: `${entry.id} already exited.` }],
					details: { id: entry.id, kind: "process", state: "exited" },
				};
			}
			terminate(entry);
			return {
				content: [{ type: "text", text: `Stopping ${entry.id} (${entry.name}).` }],
				details: { id: entry.id, kind: "process", state: "stopping" },
			};
		},
	});

	pi.registerTool({
		name: "bg_watch",
		label: "Watch for a condition",
		description: [
			"Poll a command until it succeeds without spending a model turn per poll.",
			"Use it to wait on something outside the session: CI going green, a deploy settling, a port opening.",
			"In interactive TUI/RPC mode it returns after the first poll and reports later completion; in print/JSON mode it waits and returns the outcome.",
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
					throw new Error(`Invalid "until" regex: ${(error as Error).message}`);
				}
			}

			const id = shortId();
			const intervalMs = Math.max(MIN_WATCH_INTERVAL_MS, params.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS);
			const startedAt = Date.now();
			let resolveDone!: () => void;
			const done = new Promise<void>((resolve) => {
				resolveDone = resolve;
			});
			const watch: BgWatch = {
				id,
				label: params.label ?? "condition",
				command: params.command,
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				until: params.until,
				intervalMs,
				deadline: startedAt + Math.max(0, params.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS),
				startedAt,
				polls: 0,
				lastPollAt: 0,
				state: "watching",
				lastOutput: "",
				outcome: "",
				notifyOnFinish: false,
				controller: new AbortController(),
				done,
				resolveDone,
			};
			watches.set(id, watch);

			const timeoutMessage = () =>
				`Watch ${id} timed out after ${elapsed(watch.startedAt)} waiting for ${watch.label}.\nLast output:\n${watch.lastOutput.slice(-1_500)}`;
			const onDeadline = () => settleWatch(watch, "timeout", timeoutMessage());
			watch.deadlineTimer = setTimeout(onDeadline, Math.max(0, watch.deadline - Date.now()));
			if (ctx.hasUI) watch.deadlineTimer.unref?.();

			const onAbort = () => settleWatch(watch, "cancelled", `Watch ${id} aborted.`, false);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			let polling = false;
			const poll = async () => {
				// A slow command must not stack up behind itself; skip rather than queue.
				if (polling || watch.state !== "watching") return;
				if (Date.now() >= watch.deadline) {
					onDeadline();
					return;
				}
				polling = true;
				try {
					watch.lastPollAt = Date.now();
					const remainingMs = Math.max(1, watch.deadline - Date.now());
					const { code, output } = await runOnce(
						watch.command,
						watch.cwd,
						Math.min(watch.intervalMs, remainingMs),
						watch.controller.signal,
					);
					if (watch.state !== "watching") return;
					watch.polls++;
					watch.lastOutput = output.slice(-4_000);
					// The deadline wins ties: a command completing late must not be accepted as success.
					if (Date.now() >= watch.deadline) {
						onDeadline();
						return;
					}
					const met = pattern ? pattern.test(output) : code === 0;
					if (met) {
						settleWatch(
							watch,
							"met",
							`Watch ${id} met after ${elapsed(watch.startedAt)}: ${watch.label}.\n$ ${watch.command}\n${output.slice(-1_500)}`,
						);
					}
				} catch (error) {
					if (watch.state === "watching") {
						settleWatch(
							watch,
							"failed",
							`Watch ${id} failed while waiting for ${watch.label}: ${(error as Error).message}`,
						);
					}
				} finally {
					polling = false;
				}
			};

			try {
				// Check once immediately: the condition may already hold, and waiting a full interval to
				// discover that is the most annoying possible behaviour.
				await poll();

				if (watch.state !== "watching") {
					if (watch.state !== "met") throw new Error(watch.outcome);
					return {
						content: [
							{
								type: "text",
								text: `Already true: ${watch.label}.\n${watch.lastOutput.slice(-1_500)}`,
							},
						],
						details: { id, state: watch.state, polls: watch.polls },
					};
				}

				watch.timer = setInterval(() => void poll(), intervalMs);
				if (ctx.hasUI) {
					watch.notifyOnFinish = true;
					watch.timer.unref?.();
					return {
						content: [
							{
								type: "text",
								text: `Watching ${id}: ${watch.label}, every ${Math.round(intervalMs / 1000)}s. You will be told when it is met. Carry on with other work.`,
							},
						],
						details: { id, state: watch.state, polls: watch.polls },
					};
				}

				// Print and JSON modes have no later delivery channel, so the tool owns the wait.
				await watch.done;
				const finalState = watch.state as BgWatch["state"];
				if (finalState !== "met") throw new Error(watch.outcome);
				return {
					content: [
						{
							type: "text",
							text: `Watch met after ${elapsed(watch.startedAt)}: ${watch.label}.\n${watch.lastOutput.slice(-1_500)}`,
						},
					],
					details: { id, state: finalState, polls: watch.polls },
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});

	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		for (const watch of [...watches.values()]) {
			settleWatch(watch, "cancelled", `Watch ${watch.id} cancelled by session shutdown.`, false);
		}
		if (nudgeTimer) clearTimeout(nudgeTimer);
		nudgeTimer = undefined;
		pendingLines = [];
		let survivors = 0;
		for (const entry of running.values()) {
			// keepAlive is the whole point of keepAlive: leave those running.
			if (entry.keepAlive && isAlive(entry)) {
				survivors++;
				closeLog(entry);
				continue;
			}
			// Immediate: the graceful escalation runs on a timer, and an exiting process never
			// reaches it, so a child that ignores SIGTERM would outlive the session it belongs to.
			terminate(entry, true);
			closeLog(entry);
		}
		running.clear();
		// Logs of a process that is still running are still being written to; everything else is
		// scratch that would otherwise sit in /tmp forever.
		const finishedRoot = logRoot;
		logRoot = undefined;
		if (survivors === 0 && finishedRoot !== undefined) {
			try {
				fs.rmSync(finishedRoot, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});
}
