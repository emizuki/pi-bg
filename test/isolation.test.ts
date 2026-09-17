import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, resultText } from "./harness.ts";

function idFrom(details: unknown): string {
  const id = (details as { id?: unknown } | undefined)?.id;
  assert.equal(typeof id, "string");
  return id as string;
}

test("extension instances cannot list or stop each other's work", async (t) => {
  const first = createHarness();
  const second = createHarness();
  t.after(async () => {
    await first.shutdown();
    await second.shutdown();
  });
  const started = await second.execute("bg_start", { command: "sleep 10", name: "second-session" });
  const id = idFrom(started.details);

  assert.equal(resultText(await first.execute("bg_list")), "Nothing running.");
  await assert.rejects(first.execute("bg_stop", { id }), /No process or watch/);
  assert.match(resultText(await second.execute("bg_list")), new RegExp(id));
});

test("shutting down one extension instance leaves another instance's work intact", async (t) => {
  const first = createHarness();
  const second = createHarness();
  t.after(async () => {
    await first.shutdown();
    await second.shutdown();
  });
  const started = await second.execute("bg_start", { command: "sleep 10", name: "survivor" });
  const id = idFrom(started.details);

  await first.shutdown();

  assert.match(resultText(await second.execute("bg_list")), new RegExp(id));
});
