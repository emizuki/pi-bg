import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createHarness, delay, resultText } from "./harness.ts";

function details<T>(value: unknown): T {
  return value as T;
}

async function waitUntilExited(harness: ReturnType<typeof createHarness>, id: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (resultText(await harness.execute("bg_list")).includes(`${id}  `) && resultText(await harness.execute("bg_list")).includes("exited")) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Process ${id} did not exit`);
}

test("bg_logs stays within Pi's byte limit and identifies the full log", { timeout: 4_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const started = await harness.execute("bg_start", {
    command: `node -e 'process.stdout.write("x".repeat(60 * 1024))'`,
    name: "large-line",
  });
  const { id, logFile } = details<{ id: string; logFile: string }>(started.details);
  await waitUntilExited(harness, id);

  const output = resultText(await harness.execute("bg_logs", { id, tail: 1 }));

  assert.ok(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES, `returned ${Buffer.byteLength(output)} bytes`);
  assert.match(output, /truncated/i);
  assert.match(output, new RegExp(logFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("bg_logs stays within Pi's line limit", { timeout: 4_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const started = await harness.execute("bg_start", {
    command: `node -e 'for (let i = 0; i < 2500; i++) console.log(i)'`,
    name: "many-lines",
  });
  const { id } = details<{ id: string }>(started.details);
  await waitUntilExited(harness, id);

  const output = resultText(await harness.execute("bg_logs", { id, tail: 3_000 }));

  assert.ok(output.split("\n").length <= DEFAULT_MAX_LINES, `returned ${output.split("\n").length} lines`);
  assert.match(output, /truncated/i);
});

test("bg_list truncates an oversized registry result", { timeout: 5_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  for (let index = 0; index < 18; index++) {
    await harness.execute("bg_watch", {
      command: "false",
      label: `${index}-${"L".repeat(3_000)}`,
      intervalMs: 5_000,
      timeoutMs: 30_000,
    });
  }

  const output = resultText(await harness.execute("bg_list"));
  assert.ok(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES, `returned ${Buffer.byteLength(output)} bytes`);
  assert.match(output, /truncated/i);
});
