import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { coverage, coverageMarkdown } from "../tools/check-coverage.ts";

const extra = JSON.parse(readFileSync("examples/checks-broken/manifest.json", "utf8"));

test("every broken copy in examples/checks-broken fails on exactly the checks its manifest lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-checks-broken-"));
  try {
    for (const c of extra.copies) {
      const base = `examples/checks-broken/${c.name}`;
      const args = ["--disable-warning=ExperimentalWarning", "bin/imani.js", "check", "--disclosure", `${base}/disclosure.json`, "--result", `${base}/result.json`, ...(c.chain ? ["--scan", "--chain", `${base}/${c.chain}`] : []), "--out", dir];
      const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 1 << 26 });
      assert.equal(r.status, 1, `${c.name} should FAIL`);
      const failed: string[] = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).failed;
      assert.deepEqual([...failed].sort(), [...c.expectedFailingChecks].sort(), c.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every check Imani runs has a broken copy that makes it fail, and the published table is current", () => {
  const rows = coverage();
  const uncovered = rows.filter((r) => !r.failsOn.length).map((r) => r.id);
  assert.deepEqual(uncovered, [], "checks with no broken copy");
  assert.equal(readFileSync("docs/CHECK_COVERAGE.md", "utf8"), coverageMarkdown(rows), "run: npm run coverage");
});
