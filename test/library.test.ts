import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lib from "../src/index.ts";

// docs/LIBRARY.md lists every name the package exports, one per table row, in backticks in the first column.
const doc = readFileSync("docs/LIBRARY.md", "utf8");
const documented = new Set([...doc.matchAll(/^\|\s*`([A-Za-z0-9_]+)`\s*\|/gm)].map((m) => m[1]));
const source = readFileSync("src/index.ts", "utf8");

test("every name the package exports at run time is documented in docs/LIBRARY.md", () => {
  const missing = Object.keys(lib).filter((n) => !documented.has(n));
  assert.deepEqual(missing, [], `add these to docs/LIBRARY.md: ${missing.join(", ")}`);
});

test("every name documented in docs/LIBRARY.md is exported (as a value or a type)", () => {
  const runtime = new Set(Object.keys(lib));
  const stale = [...documented].filter((n) => !runtime.has(n) && !new RegExp("\\btype " + n + "\\b").test(source));
  assert.deepEqual(stale, [], `docs/LIBRARY.md names something src/index.ts does not export: ${stale.join(", ")}`);
});

test("the main entry runs a check and refuses a spending key", () => {
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const d = read("examples/round-01/disclosure.json");
  const r = read("examples/round-01/result.json");
  assert.equal(lib.checkLot(d, r).result, "PASS");
  assert.throws(() => lib.assertViewingKey("secret-extended-key-main1qqqqqqqq", "main"), lib.KeyRefusedError);
});
