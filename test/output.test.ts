import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createHarness, delay, resultText } from "./harness.ts";

function details<T>(value: unknown): T {
  return value as T;
}

const oversizedDisplayValue = `${"x\n".repeat(2_100)}${"x".repeat(DEFAULT_MAX_BYTES)}`;

function assertBounded(output: string): void {
  assert.ok(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES, `returned ${Buffer.byteLength(output)} bytes`);
  assert.ok(output.split("\n").length <= DEFAULT_MAX_LINES, `returned ${output.split("\n").length} lines`);
  assert.match(output, /truncated/i);
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

  assertBounded(resultText(await harness.execute("bg_list")));
});

test("bg_start truncates an oversized process name", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  const result = await harness.execute("bg_start", {
    command: "sleep 1",
    name: oversizedDisplayValue,
  });

  assertBounded(resultText(result));
});

test("bg_stop truncates an oversized process name", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const started = await harness.execute("bg_start", {
    command: "sleep 10",
    name: oversizedDisplayValue,
  });

  const result = await harness.execute("bg_stop", { id: details<{ id: string }>(started.details).id });

  assertBounded(resultText(result));
});

test("an immediate bg_watch result truncates an oversized label", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  const result = await harness.execute("bg_watch", {
    command: "true",
    label: oversizedDisplayValue,
  });

  assertBounded(resultText(result));
});

test("a background bg_watch result truncates an oversized label", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  const result = await harness.execute("bg_watch", {
    command: "false",
    label: oversizedDisplayValue,
    timeoutMs: 10_000,
  });

  assertBounded(resultText(result));
});

test("tool failures truncate oversized identifiers", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  await assert.rejects(
    harness.execute("bg_logs", { id: oversizedDisplayValue }),
    (error: Error) => {
      assertBounded(error.message);
      return true;
    },
  );
});

test("blocking watch failures truncate oversized labels", async (t) => {
  const harness = createHarness({ hasUI: false, mode: "print" });
  t.after(() => harness.shutdown());

  await assert.rejects(
    harness.execute(
      "bg_watch",
      { command: "false", label: oversizedDisplayValue, timeoutMs: 20 },
      { hasUI: false, mode: "print" },
    ),
    (error: Error) => {
      assertBounded(error.message);
      return true;
    },
  );
});

test("background notifications truncate oversized labels", { timeout: 3_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  await harness.execute("bg_watch", {
    command: "false",
    label: oversizedDisplayValue,
    timeoutMs: 20,
  });

  const deadline = Date.now() + 2_000;
  while (harness.notifications.length === 0 && Date.now() < deadline) await delay(20);

  assert.equal(harness.notifications.length, 1);
  assertBounded(harness.notifications[0]?.message.content ?? "");
});
