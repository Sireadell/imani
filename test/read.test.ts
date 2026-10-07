import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTransaction } from "../src/read.ts";

const vector = JSON.parse(readFileSync(new URL("./vectors/ledger-testnet-orchard-internal.json", import.meta.url), "utf8"));

test("reads amounts from a viewing key alone", () => {
  const out = readTransaction(vector.txHex, vector.ufvk);
  assert.equal(out.length, 2);
  for (const o of out) {
    assert.equal(o.pool, "orchard");
    assert.equal(o.amountZat, 14490000);
    assert.equal(o.transferType, "internal");
  }
});

test("a malformed key is rejected with a clear error", () => {
  assert.throws(() => readTransaction(vector.txHex, "not-a-key"), /UFVK decode failed/);
});
