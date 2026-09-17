import * as fs from "node:fs";
import { createHarness } from "../harness.ts";

const pidFile = process.env.PI_BG_TEST_PID_FILE;
const ownerPidFile = process.env.PI_BG_TEST_OWNER_PID_FILE;
if (!pidFile || !ownerPidFile) throw new Error("PI_BG_TEST_PID_FILE and PI_BG_TEST_OWNER_PID_FILE are required");
fs.writeFileSync(ownerPidFile, String(process.pid));
const harness = createHarness({ hasUI: true });
void harness
  .execute("bg_watch", {
    command: `echo $$ > "${pidFile}"; exec sleep 30`,
    intervalMs: 5_000,
    timeoutMs: 30_000,
    label: "crash-owned poll",
  })
  .catch(() => {});
setInterval(() => {}, 1_000);
