import { createHarness } from "../harness.ts";

const timeoutCount = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
const before = timeoutCount();
const harness = createHarness();
await harness.execute("bg_start", { command: "sleep 10", name: "shutdown-resource" });
await harness.shutdown();
const after = timeoutCount();
process.stdout.write(`${JSON.stringify({ before, after })}\n`);
process.exit(0);
