import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("a completed shutdown barrier clears its fallback timeout", { timeout: 10_000 }, () => {
  const result = spawnSync(
    path.join(projectRoot, "node_modules", ".bin", "tsx"),
    [path.join(projectRoot, "test", "fixtures", "shutdown-resources.ts")],
    { cwd: projectRoot, encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const counts = JSON.parse(result.stdout.trim()) as { before: number; after: number };
  assert.ok(counts.after <= counts.before, `timeouts before=${counts.before}, after=${counts.after}`);
});
