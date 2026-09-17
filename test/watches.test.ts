import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createHarness, delay, resultText } from "./harness.ts";

function idFrom(details: unknown): string {
  const id = (details as { id?: unknown } | undefined)?.id;
  assert.equal(typeof id, "string");
  return id as string;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await delay(20);
  }
}

test("a watch cannot succeed after its deadline", { timeout: 2_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const startedAt = Date.now();

  await assert.rejects(
    harness.execute("bg_watch", {
      command: "sleep 0.2",
      intervalMs: 5_000,
      timeoutMs: 30,
      label: "late success",
    }),
    /timed out|timeout/,
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test("a background watch times out at its deadline instead of its poll interval", { timeout: 3_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());
  const watching = await harness.execute("bg_watch", {
    command: "false",
    intervalMs: 5_000,
    timeoutMs: 100,
    label: "short deadline",
  });
  const id = idFrom(watching.details);

  await waitFor(() => harness.notifications.length === 1, 2_200);

  assert.match(harness.notifications[0]?.message.content ?? "", /timed out/);
  assert.doesNotMatch(resultText(await harness.execute("bg_list")), new RegExp(id));
});

test("an initially satisfied watch returns once without a duplicate notification", { timeout: 3_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  const result = await harness.execute("bg_watch", { command: "true", label: "already ready" });
  assert.match(resultText(result), /Already true/);
  await delay(1_700);

  assert.equal(harness.notifications.length, 0);
});

test("bg_stop kills a poll command that is already running", { timeout: 3_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-watch-stop-"));
  const marker = path.join(dir, "side-effect");
  const harness = createHarness({ cwd: dir });
  t.after(async () => {
    await harness.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const execution = harness.execute("bg_watch", {
    command: `sleep 0.4; touch "${marker}"; false`,
    intervalMs: 5_000,
    timeoutMs: 10_000,
    label: "active poll",
  });
  const settled = execution.then(
    () => undefined,
    () => undefined,
  );
  await delay(50);
  const listing = resultText(await harness.execute("bg_list"));
  const id = /\b([0-9a-f]{8})\s+active poll\s+watching\b/.exec(listing)?.[1];
  assert.ok(id, listing);

  await harness.execute("bg_stop", { id });
  await settled;
  await delay(500);

  assert.equal(fs.existsSync(marker), false);
});

test("aborting a blocking watch kills its active poll command", { timeout: 3_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-watch-abort-"));
  const marker = path.join(dir, "side-effect");
  const harness = createHarness({ cwd: dir, hasUI: false, mode: "print" });
  const controller = new AbortController();
  t.after(async () => {
    await harness.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const execution = harness.execute(
    "bg_watch",
    {
      command: `sleep 0.4; touch "${marker}"; false`,
      intervalMs: 5_000,
      timeoutMs: 10_000,
      label: "abort poll",
    },
    { signal: controller.signal, hasUI: false, mode: "print" },
  );
  await delay(50);
  controller.abort();

  await assert.rejects(execution, /aborted|cancelled/i);
  await delay(500);
  assert.equal(fs.existsSync(marker), false);
});

test("session shutdown suppresses completion from an in-flight poll", { timeout: 4_000 }, async () => {
  const harness = createHarness();
  const execution = harness.execute("bg_watch", {
    command: "sleep 0.2; true",
    intervalMs: 5_000,
    timeoutMs: 10_000,
    label: "stale completion",
  });
  const settled = execution.then(
    () => undefined,
    () => undefined,
  );
  await delay(40);

  await harness.shutdown();
  await settled;
  await delay(1_700);

  assert.equal(harness.notifications.length, 0);
});

test("a synchronous poll spawn failure leaves no registered watch", async (t) => {
  const harness = createHarness();
  t.after(() => harness.shutdown());

  await assert.rejects(
    harness.execute("bg_watch", { command: "bad\0command", timeoutMs: 1_000 }),
  );

  assert.equal(resultText(await harness.execute("bg_list")), "Nothing running.");
});
