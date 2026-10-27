import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The prebuilt WebAssembly in vendor/decoder (tools/decoder/build.sh) and vendor/disclose
// (tools/disclose/build.sh) must match the checksums written when they were built.
for (const folder of ["decoder", "disclose"]) {
  test(`vendor/${folder} files match SHA256SUMS`, () => {
    const dir = new URL(`../vendor/${folder}/`, import.meta.url);
    const lines = readFileSync(new URL("SHA256SUMS", dir), "utf8").trim().split("\n");
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      const [hash, name] = line.trim().split(/\s+\*?/);
      const actual = createHash("sha256").update(readFileSync(new URL(name, dir))).digest("hex");
      assert.equal(actual, hash, name);
    }
  });
}
