import { createHarness } from "../harness.ts";

const worker = process.env.PI_BG_TEST_WORKER;
if (!worker) throw new Error("PI_BG_TEST_WORKER is required");

const harness = createHarness();
const started = await harness.execute("bg_start", {
  command: `node "${worker}"`,
  name: "cross-process-keepalive",
  keepAlive: true,
});
await harness.shutdown();
process.stdout.write(`${JSON.stringify(started.details)}\n`);
