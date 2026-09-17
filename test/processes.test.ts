import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createHarness, delay, resultText } from "./harness.ts";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await delay(20);
  }
}

function makeIgnoringWorker(): { dir: string; pidFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-process-test-"));
  const pidFile = path.join(dir, "worker.pid");
  fs.writeFileSync(
    path.join(dir, "worker.mjs"),
    [
      'import fs from "node:fs";',
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  return { dir, pidFile };
}

function idFrom(details: unknown): string {
  const id = (details as { id?: unknown } | undefined)?.id;
  assert.equal(typeof id, "string");
  return id as string;
}

async function cleanWorker(harness: ReturnType<typeof createHarness>, dir: string, pid?: number): Promise<void> {
  if (pid !== undefined && processAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitFor(() => !processAlive(pid)).catch(() => {});
  }
  await harness.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}

test("bg_stop escalates against a process group after its shell leader exits", { timeout: 9_000 }, async (t) => {
  const { dir, pidFile } = makeIgnoringWorker();
  const harness = createHarness({ cwd: dir });
  let workerPid: number | undefined;
  t.after(() => cleanWorker(harness, dir, workerPid));
  const started = await harness.execute("bg_start", {
    command: `cd "${dir}" && node worker.mjs`,
    name: "ignore-term",
  });
  await waitFor(() => fs.existsSync(pidFile));
  workerPid = Number(fs.readFileSync(pidFile, "utf8"));

  await harness.execute("bg_stop", { id: idFrom(started.details) });
  await delay(5_500);

  assert.equal(processAlive(workerPid), false);
});

test("session shutdown immediately kills an entry that is already stopping", { timeout: 4_000 }, async (t) => {
  const { dir, pidFile } = makeIgnoringWorker();
  const harness = createHarness({ cwd: dir });
  let workerPid: number | undefined;
  t.after(() => cleanWorker(harness, dir, workerPid));
  const started = await harness.execute("bg_start", {
    command: `cd "${dir}" && node worker.mjs`,
    name: "shutdown-ignore-term",
  });
  await waitFor(() => fs.existsSync(pidFile));
  workerPid = Number(fs.readFileSync(pidFile, "utf8"));

  await harness.execute("bg_stop", { id: idFrom(started.details) });
  await harness.shutdown();
  await delay(200);

  assert.equal(processAlive(workerPid), false);
});

test("background logs are owner-only", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const started = await harness.execute("bg_start", { command: "sleep 1", name: "private-log" });
  const logFile = (started.details as { logFile?: unknown }).logFile;
  assert.equal(typeof logFile, "string");
  const resolvedLogFile = logFile as string;

  assert.equal(fs.statSync(path.dirname(resolvedLogFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(resolvedLogFile).mode & 0o777, 0o600);
});

test("exited process history is pruned when children close", { timeout: 5_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const ids: string[] = [];

  for (let index = 0; index < 25; index++) {
    const result = await harness.execute("bg_start", {
      command: "sleep 0.8",
      name: `batch-${index}`,
    });
    ids.push(idFrom(result.details));
  }
  await delay(1_100);

  const listing = resultText(await harness.execute("bg_list"));
  const retained = ids.filter((id) => listing.includes(id));
  assert.ok(retained.length <= 20, `retained ${retained.length} exited processes`);
});

test("a synchronous spawn failure cleans up its log descriptor", async (t) => {
  if (!fs.existsSync("/proc/self/fd")) {
    t.skip("descriptor accounting requires /proc");
    return;
  }
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const before = fs.readdirSync("/proc/self/fd").length;

  await assert.rejects(
    harness.execute("bg_start", { command: "bad\0command" }),
  );

  assert.equal(fs.readdirSync("/proc/self/fd").length, before);
});

test("an asynchronous spawn failure sends only one failure notification", { timeout: 4_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const missingCwd = path.join(os.tmpdir(), `pi-bg-missing-${process.pid}-${Date.now()}`);

  await harness.execute("bg_start", { command: "true", cwd: missingCwd, name: "missing-cwd" });
  await delay(1_700);

  assert.equal(harness.notifications.length, 1);
  const body = harness.notifications[0]?.message.content ?? "";
  assert.match(body, /failed to start/);
  assert.doesNotMatch(body, /exited -?\d/);
});
