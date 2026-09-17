import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { createHarness } from "./harness.ts";

test("successful tool results include structured details", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  const result = await harness.execute("bg_list");

  assert.ok(Object.hasOwn(result, "details"));
});

test("unknown process ids reject the tool call", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  await assert.rejects(
    harness.execute("bg_logs", { id: "missing" }),
    /No process "missing"/,
  );
});

test("rejecting a self-backgrounding command does not leak a descriptor", async (t) => {
  if (!fs.existsSync("/proc/self/fd")) {
    t.skip("descriptor accounting requires /proc");
    return;
  }
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const before = fs.readdirSync("/proc/self/fd").length;
  let failure: unknown;

  try {
    await harness.execute("bg_start", { command: "sleep 1 &" });
  } catch (error) {
    failure = error;
  }

  assert.match(String(failure), /Drop the trailing '&'/);
  assert.equal(fs.readdirSync("/proc/self/fd").length, before);
});
