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

test("auction round: the lot key reads every transaction like librustzcash, and txids match", async () => {
  const { readTransactionWithId } = await import("../src/read.ts");
  const a = JSON.parse(readFileSync(new URL("./vectors/auction-round.json", import.meta.url), "utf8"));
  const lotKey = a.parties["lot LOT-01"].ufvk;
  assert.equal(Object.keys(a.transactions).length, 12);
  for (const [name, t] of Object.entries<any>(a.transactions)) {
    const got = readTransactionWithId(t.txHex, lotKey);
    assert.equal(got.txid, t.txid, name);
    const want = t.lotKeySees.map((o: any) => ({
      pool: o.pool,
      amountZat: o.amountZat,
      memo: o.memo,
      transferType: o.transferType.toLowerCase(),
    }));
    assert.deepEqual(got.outputs, want, name);
  }
});

// NU7 vectors made by tools/gen-vectors/gen_nu7.rs: Ironwood, version 6, testnet NU7 rules
// (branch id 0x77190ad9), same throwaway buyer, seller and stranger keys as above.
const n = JSON.parse(readFileSync(new URL("./vectors/nu7-offline.json", import.meta.url), "utf8"));

test("NU7 payment: seller reads it as incoming with its memo, stranger sees nothing", async () => {
  const { readTransactionWithId } = await import("../src/read.ts");
  const c = n.cases.ironwood_nu7_payment;
  assert.equal(c.branchId, "0x77190ad9");
  const got = readTransactionWithId(c.txHex, n.parties.seller.ufvk);
  assert.equal(got.txid, c.txid);
  assert.deepEqual(got.outputs, [{ pool: "ironwood", amountZat: 1_250_000, memo: "imani order 43: NU7 rules", transferType: "incoming" }]);
  assert.deepEqual(readTransaction(c.txHex, n.parties.stranger.ufvk), []);
});

test("NU7 refund: seller reads it as outgoing, buyer as incoming, both with the memo", () => {
  const c = n.cases.ironwood_nu7_refund;
  const want = { pool: "ironwood", amountZat: 400_000, memo: "imani refund for order 43" };
  assert.deepEqual(readTransaction(c.txHex, n.parties.seller.ufvk), [{ ...want, transferType: "outgoing" }]);
  assert.deepEqual(readTransaction(c.txHex, n.parties.buyer.ufvk), [{ ...want, transferType: "incoming" }]);
  assert.deepEqual(readTransaction(c.txHex, n.parties.stranger.ufvk), []);
});

// The NU7 generator encodes the keys without the transparent part, so the key text is
// shorter, but it is the same seed and account: same addresses, same reads.
test("NU7 vectors use the same wallets as the older vectors", () => {
  for (const p of ["buyer", "seller", "stranger"]) assert.equal(n.parties[p].address, v.parties[p].address, p);
  assert.deepEqual(readTransaction(v.cases.ironwood_v6_payment.txHex, n.parties.seller.ufvk), [
    { pool: "ironwood", amountZat: 1_250_000, memo: PAY_MEMO, transferType: "incoming" },
  ]);
  assert.deepEqual(readTransaction(n.cases.ironwood_nu7_payment.txHex, v.parties.seller.ufvk), [
    { pool: "ironwood", amountZat: 1_250_000, memo: "imani order 43: NU7 rules", transferType: "incoming" },
  ]);
});
