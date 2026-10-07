import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The prebuilt decoder in vendor/decoder must match the checksums written by tools/decoder/build.sh.
test("vendor/decoder files match SHA256SUMS", () => {
  const dir = new URL("../vendor/decoder/", import.meta.url);
  const lines = readFileSync(new URL("SHA256SUMS", dir), "utf8").trim().split("\n");
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    const actual = createHash("sha256").update(readFileSync(new URL(name, dir))).digest("hex");
    assert.equal(actual, hash, name);
  }
});
