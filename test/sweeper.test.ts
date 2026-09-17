import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createHarness, delay } from "./harness.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("startup sweep preserves a dead owner's root while a keepAlive group still writes", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-sweep-test-"));
  const pidFile = path.join(dir, "worker.pid");
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(
    worker,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      'setInterval(() => console.log("tick"), 50);',
      "",
    ].join("\n"),
  );
  let workerPid: number | undefined;
  let logRoot: string | undefined;
  t.after(async () => {
    if (workerPid !== undefined && alive(workerPid)) process.kill(workerPid, "SIGKILL");
    await delay(100);
    if (logRoot) fs.rmSync(logRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = spawnSync(
    path.join(projectRoot, "node_modules", ".bin", "tsx"),
    [path.join(projectRoot, "test", "fixtures", "start-keepalive.ts")],
    {
      cwd: projectRoot,
      env: { ...process.env, PI_BG_TEST_WORKER: worker },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim()) as { logFile: string };
  logRoot = path.dirname(parsed.logFile);
  for (let attempt = 0; attempt < 50 && !fs.existsSync(pidFile); attempt++) await delay(20);
  workerPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(alive(workerPid), true);

  const nextSession = createHarness();
  await nextSession.shutdown();
  await delay(150);

  assert.equal(fs.existsSync(parsed.logFile), true);
  assert.match(fs.readFileSync(parsed.logFile, "utf8"), /tick/);
});
