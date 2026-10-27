import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// docs/FORMAT.md must say how big each field of the round files can be.
test("FORMAT.md has a field sizes section with the real limits", () => {
  const doc = readFileSync("docs/FORMAT.md", "utf8");
  assert.match(doc, /^### Field sizes/m);
  for (const needle of ["1 to 40", "64 lowercase hex", "32 hex", "512", "16 digits", "no upper limit"]) {
    assert.ok(doc.includes(needle), `Field sizes section should mention: ${needle}`);
  }
});
