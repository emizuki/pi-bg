import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

test("startup sweep preserves a legacy root whose writer ownership is uncertain", { timeout: 5_000 }, async (t) => {
  const deadOwnerPid = 900_000_000 + (process.pid % 10_000);
  const legacyRoot = path.join(os.tmpdir(), `pi-bg-${deadOwnerPid}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-legacy-sweep-"));
  const worker = path.join(dir, "worker.mjs");
  const logFile = path.join(legacyRoot, "legacy.log");
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  fs.mkdirSync(legacyRoot, { mode: 0o700 });
  fs.writeFileSync(worker, 'setInterval(() => console.log("legacy-tick"), 50);\n');
  const out = fs.openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [worker], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  fs.closeSync(out);
  child.unref();
  t.after(async () => {
    if (child.pid !== undefined && alive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        process.kill(child.pid, "SIGKILL");
      }
    }
    await delay(100);
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await delay(100);

  const nextSession = createHarness();
  await nextSession.shutdown();

  assert.equal(fs.existsSync(logFile), true);
  assert.match(fs.readFileSync(logFile, "utf8"), /legacy-tick/);
});

test("startup sweep preserves a prior metadata schema with uncertain live writers", { timeout: 5_000 }, async (t) => {
  const deadOwnerPid = 905_000_000 + (process.pid % 10_000);
  const root = path.join(os.tmpdir(), `pi-bg-${deadOwnerPid}-old-schema`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-old-schema-"));
  const worker = path.join(dir, "worker.mjs");
  const logFile = path.join(root, "writer.log");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".owner.json"), `${JSON.stringify({ ownerPid: deadOwnerPid, keepAliveGroups: [] })}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(worker, 'setInterval(() => console.log("old-schema-tick"), 50);\n');
  const out = fs.openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [worker], { detached: true, stdio: ["ignore", out, out] });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  fs.closeSync(out);
  child.unref();
  t.after(async () => {
    if (child.pid !== undefined && alive(child.pid)) process.kill(-child.pid, "SIGKILL");
    await delay(100);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await delay(100);

  const nextSession = createHarness();
  await nextSession.shutdown();

  assert.equal(fs.existsSync(logFile), true);
  assert.equal(child.pid === undefined ? false : alive(child.pid), true);
});

test("startup sweep preserves a root with an interrupted keepAlive registration", async (t) => {
  const deadOwnerPid = 910_000_000 + (process.pid % 10_000);
  const root = path.join(os.tmpdir(), `pi-bg-${deadOwnerPid}-pending`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(
    path.join(root, ".owner.json"),
    `${JSON.stringify({
      version: 1,
      ownerPid: deadOwnerPid,
      keepAliveGroups: [],
      managedGroups: [],
      pendingKeepAlive: ["pending"],
      pendingManaged: [],
    })}\n`,
    { mode: 0o600 },
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const nextSession = createHarness();
  await nextSession.shutdown();

  assert.equal(fs.existsSync(root), true);
});

test("startup sweep kills managed groups left by a dead owner", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("safe orphan reclamation requires Linux process birth identities");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-managed-sweep-"));
  const pidFile = path.join(dir, "worker.pid");
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(
    worker,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      'setInterval(() => console.log("managed-tick"), 50);',
      "",
    ].join("\n"),
  );
  let workerPid: number | undefined;
  let logRoot: string | undefined;
  t.after(async () => {
    if (workerPid === undefined && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, "utf8"));
    if (workerPid !== undefined && alive(workerPid)) process.kill(workerPid, "SIGKILL");
    await delay(100);
    if (logRoot) fs.rmSync(logRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = spawnSync(
    path.join(projectRoot, "node_modules", ".bin", "tsx"),
    [path.join(projectRoot, "test", "fixtures", "start-managed.ts")],
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
  for (let attempt = 0; attempt < 50 && alive(workerPid); attempt++) await delay(20);

  assert.equal(alive(workerPid), false);
});

test("startup sweep reclaims an active poll group after its owner crashes", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("safe orphan reclamation requires Linux process birth identities");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-poll-crash-"));
  const pidFile = path.join(dir, "poll.pid");
  const ownerPidFile = path.join(dir, "owner.pid");
  const owner = spawn(
    path.join(projectRoot, "node_modules", ".bin", "tsx"),
    [path.join(projectRoot, "test", "fixtures", "start-poll-and-wait.ts")],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_BG_TEST_PID_FILE: pidFile,
        PI_BG_TEST_OWNER_PID_FILE: ownerPidFile,
      },
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve, reject) => {
    owner.once("spawn", resolve);
    owner.once("error", reject);
  });
  const ownerExit = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
  let extensionOwnerPid: number | undefined;
  let pollPid: number | undefined;
  t.after(async () => {
    if (extensionOwnerPid === undefined && fs.existsSync(ownerPidFile)) {
      extensionOwnerPid = Number(fs.readFileSync(ownerPidFile, "utf8"));
    }
    if (extensionOwnerPid !== undefined && alive(extensionOwnerPid)) process.kill(extensionOwnerPid, "SIGKILL");
    if (owner.pid !== undefined && alive(owner.pid)) process.kill(owner.pid, "SIGKILL");
    if (pollPid === undefined && fs.existsSync(pidFile)) pollPid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pollPid !== undefined && alive(pollPid)) process.kill(-pollPid, "SIGKILL");
    await delay(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (
    let attempt = 0;
    attempt < 100 && (!fs.existsSync(pidFile) || !fs.existsSync(ownerPidFile));
    attempt++
  ) {
    await delay(20);
  }
  extensionOwnerPid = Number(fs.readFileSync(ownerPidFile, "utf8"));
  pollPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(alive(pollPid), true);

  process.kill(extensionOwnerPid, "SIGKILL");
  await ownerExit;
  assert.equal(alive(extensionOwnerPid), false);
  const nextSession = createHarness();
  await nextSession.shutdown();
  for (let attempt = 0; attempt < 50 && alive(pollPid); attempt++) await delay(20);

  assert.equal(alive(pollPid), false);
});

test("startup sweep never trusts process metadata from a non-private root", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("safe orphan reclamation requires Linux process birth identities");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-untrusted-sweep-"));
  const pidFile = path.join(dir, "worker.pid");
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(
    worker,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      "",
    ].join("\n"),
  );
  let workerPid: number | undefined;
  let logRoot: string | undefined;
  t.after(async () => {
    if (workerPid === undefined && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, "utf8"));
    if (workerPid !== undefined && alive(workerPid)) process.kill(workerPid, "SIGKILL");
    await delay(100);
    if (logRoot) fs.rmSync(logRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = spawnSync(
    path.join(projectRoot, "node_modules", ".bin", "tsx"),
    [path.join(projectRoot, "test", "fixtures", "start-managed.ts")],
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
  fs.chmodSync(logRoot, 0o777);
  for (let attempt = 0; attempt < 50 && !fs.existsSync(pidFile); attempt++) await delay(20);
  workerPid = Number(fs.readFileSync(pidFile, "utf8"));

  const nextSession = createHarness();
  await nextSession.shutdown();

  assert.equal(alive(workerPid), true);
  assert.equal(fs.existsSync(logRoot), true);
});

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
    if (workerPid === undefined && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, "utf8"));
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
