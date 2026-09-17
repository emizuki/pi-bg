import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("check.sh fails on TypeScript diagnostics outside the old name-error allowlist", { timeout: 10_000 }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-check-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "extensions", "bg"), { recursive: true });
  for (const file of ["check.sh", "package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(fixture, file));
  }
  fs.copyFileSync(
    path.join(projectRoot, "extensions", "bg", "index.ts"),
    path.join(fixture, "extensions", "bg", "index.ts"),
  );
  fs.appendFileSync(
    path.join(fixture, "extensions", "bg", "index.ts"),
    '\nconst deliberatelyInvalidType: string = 1;\n',
  );
  fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(fixture, "node_modules"), "dir");
  fs.chmodSync(path.join(fixture, "check.sh"), 0o755);

  const result = spawnSync("./check.sh", { cwd: fixture, encoding: "utf8" });

  assert.notEqual(result.status, 0, `check.sh unexpectedly passed:\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /TS2322/);
});
