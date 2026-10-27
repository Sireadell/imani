// docs/PROOF.md lists each headline claim with the one command that proves it and the exact
// line that command prints. This test runs those commands and compares the printed line.
//
// Skipped here because they are slow (tools/proof-run.ts --all runs them):
//   - npm run test:all           (the whole test run, about 10 minutes)
//   - npx tsx --test test/browser-bundle.test.ts   (builds the browser file first, about 1 minute)
//   - npm run leak-scan:history  (reads every commit, about 4 minutes)
//   - npm run conformance        (52 verdicts through the command line, about 1 minute)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseProof, isSlow, runProof } from "../tools/proof-run.ts";

const path = new URL("../docs/PROOF.md", import.meta.url);

test("docs/PROOF.md exists and has one row per headline claim", () => {
  assert.ok(existsSync(path), "docs/PROOF.md is missing");
  const rows = parseProof(readFileSync(path, "utf8"));
  const all = rows.map((r) => r.claim.toLowerCase()).join("\n");
  for (const word of ["test network", "mainnet", "changed copy", "52 of 52", "browser", "leak", "test count"]) {
    assert.ok(all.includes(word), `no row mentions "${word}"`);
  }
  for (const r of rows) {
    assert.match(r.command, /^(node bin\/imani\.js|npm run|npx tsx)/);
    assert.ok(r.expected.length > 0);
  }
  assert.ok(rows.some((r) => isSlow(r.command)), "the slow rows should be marked");
});

test("every quick command prints exactly the line the file shows", async () => {
  const rows = parseProof(readFileSync(path, "utf8"));
  const results = await runProof(rows, { all: false });
  const bad = results.filter((r) => r.status === "different");
  assert.deepEqual(bad.map((r) => `${r.command} -> ${r.printed}`), []);
  assert.ok(results.filter((r) => r.status === "same").length >= 6);
});

test("a changed line is reported as different, and the slow rows are skipped", async () => {
  const md = "| Claim | Command | Result line |\n|---|---|---|\n| x | `node bin/imani.js check --disclosure examples/broken/04-short-refund/disclosure.json --result examples/broken/04-short-refund/result.json` | `RESULT: PASS (15 of 15 checks passed)` |\n| y | `npm run test:all` | `anything` |\n";
  const results = await runProof(parseProof(md), { all: false });
  assert.equal(results[0].status, "different");
  assert.equal(results[1].status, "skipped");
});
