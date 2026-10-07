import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTransaction } from "../src/read.ts";

// Offline vectors made by tools/gen-vectors: throwaway keys, invented funding, never broadcast.
const v = JSON.parse(readFileSync(new URL("./vectors/offline-vectors.json", import.meta.url), "utf8"));
const { buyer, seller, stranger } = v.parties;
const PAY_MEMO = "imani order 42: 2 bags of rice";
const REFUND_MEMO = "imani refund for order 42";

// One row per case in the spike table. Orchard under NU6.1 (v5), Orchard under NU6.2 (v5),
// and Ironwood under NU6.3 (v6).
const payments = [
  { name: "orchard_v5_payment", pool: "orchard" },
  { name: "orchard_nu6_2_payment", pool: "orchard" },
  { name: "ironwood_v6_payment", pool: "ironwood" },
] as const;
const refunds = [
  { name: "orchard_v5_refund", pool: "orchard" },
  { name: "ironwood_v6_refund", pool: "ironwood" },
] as const;

for (const { name, pool } of payments) {
  test(`${name}: seller's viewing key reads the incoming payment with its memo`, () => {
    const out = readTransaction(v.cases[name].txHex, seller.ufvk);
    assert.deepEqual(out, [{ pool, amountZat: 1_250_000, memo: PAY_MEMO, transferType: "incoming" }]);
  });
}

for (const { name, pool } of refunds) {
  test(`${name}: seller's viewing key reads its own refund as outgoing`, () => {
    const out = readTransaction(v.cases[name].txHex, seller.ufvk);
    assert.deepEqual(out, [{ pool, amountZat: 400_000, memo: REFUND_MEMO, transferType: "outgoing" }]);
  });

  test(`${name}: buyer's viewing key reads the same refund as incoming`, () => {
    const out = readTransaction(v.cases[name].txHex, buyer.ufvk);
    assert.deepEqual(out, [{ pool, amountZat: 400_000, memo: REFUND_MEMO, transferType: "incoming" }]);
  });
}

test("a stranger's viewing key sees nothing in any case", () => {
  for (const name of Object.keys(v.cases)) {
    assert.deepEqual(readTransaction(v.cases[name].txHex, stranger.ufvk), [], name);
  }
});

test("every case agrees with the librustzcash record stored in the vector file", () => {
  for (const [name, c] of Object.entries<any>(v.cases)) {
    for (const party of ["buyer", "seller", "stranger"]) {
      const got = readTransaction(c.txHex, v.parties[party].ufvk);
      const want = c.librustzcashDecrypt[party].map((o: any) => ({
        pool: o.pool,
        amountZat: o.amountZat,
        memo: o.memo,
        transferType: o.transferType.toLowerCase(),
      }));
      assert.deepEqual(got, want, `${name} / ${party}`);
    }
  }
});
