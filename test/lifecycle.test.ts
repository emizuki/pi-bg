import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createHarness, delay } from "./harness.ts";

function startDetails(details: unknown): { logFile: string } {
  const logFile = (details as { logFile?: unknown } | undefined)?.logFile;
  assert.equal(typeof logFile, "string");
  return { logFile: logFile as string };
}

test("a keepAlive process survives shutdown without notifying the stale session", { timeout: 4_000 }, async (t) => {
  const first = createHarness();
  const started = await first.execute("bg_start", {
    command: "sleep 0.15; printf 'survived\\n'",
    name: "keepalive",
    keepAlive: true,
  });
  const { logFile } = startDetails(started.details);
  const firstRoot = path.dirname(logFile);
  t.after(() => fs.rmSync(firstRoot, { recursive: true, force: true }));

  await first.shutdown();
  await delay(1_800);

  assert.match(fs.readFileSync(logFile, "utf8"), /survived/);
  assert.equal(first.notifications.length, 0);
});

test("a later session cannot remove a previous keepAlive process log root", { timeout: 4_000 }, async (t) => {
  const first = createHarness();
  const survivor = await first.execute("bg_start", {
    command: "sleep 0.15; printf 'still-here\\n'",
    name: "keepalive-root",
    keepAlive: true,
  });
  const { logFile: survivorLog } = startDetails(survivor.details);
  const survivorRoot = path.dirname(survivorLog);
  t.after(() => fs.rmSync(survivorRoot, { recursive: true, force: true }));
  await first.shutdown();

  const second = createHarness();
  const ordinary = await second.execute("bg_start", { command: "true", name: "next-session" });
  const { logFile: secondLog } = startDetails(ordinary.details);
  assert.notEqual(path.dirname(secondLog), survivorRoot);
  await delay(300);
  await second.shutdown();
  await delay(100);

  assert.equal(fs.existsSync(survivorLog), true);
  assert.match(fs.readFileSync(survivorLog, "utf8"), /still-here/);
});
