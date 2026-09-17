import fs from "node:fs";
const pidFile = process.env.PI_BG_TEST_PID_FILE;
if (!pidFile) throw new Error("PI_BG_TEST_PID_FILE is required");
fs.writeFileSync(pidFile, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
