import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTransaction } from "../src/read.ts";

// Offline vectors made by tools/gen-vectors: throwaway keys, invented funding, never broadcast.
const v = JSON.parse(readFileSync(new URL("./vectors/offline-vectors.json", import.meta.url), "utf8"));
const { buyer, seller, stranger } = v.parties;
const payment = v.cases.orchard_v5_payment;
const refund = v.cases.orchard_v5_refund;

test("seller's viewing key reads an incoming payment with its memo", () => {
  const out = readTransaction(payment.txHex, seller.ufvk);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    pool: "orchard",
    amountZat: 1_250_000,
    memo: "imani order 42: 2 bags of rice",
    transferType: "incoming",
  });
});

test("seller's viewing key reads its own refund as outgoing", () => {
  const out = readTransaction(refund.txHex, seller.ufvk);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    pool: "orchard",
    amountZat: 400_000,
    memo: "imani refund for order 42",
    transferType: "outgoing",
  });
});

test("buyer's viewing key reads the same refund as incoming", () => {
  const out = readTransaction(refund.txHex, buyer.ufvk);
  assert.equal(out.length, 1);
  assert.equal(out[0].transferType, "incoming");
  assert.equal(out[0].amountZat, 400_000);
});

test("a stranger's viewing key sees nothing", () => {
  assert.deepEqual(readTransaction(payment.txHex, stranger.ufvk), []);
  assert.deepEqual(readTransaction(refund.txHex, stranger.ufvk), []);
});

// Known gaps in @ledgerhq/zcash-decrypt 0.2.0, recorded as they really behave.
// librustzcash reads all of these correctly (see librustzcashDecrypt in the vector file).
// If a later reader passes them, these tests fail on purpose so the gap can be closed.

test("known gap: NU6.2 transactions are rejected (unknown branch id)", () => {
  const c = v.cases.orchard_nu6_2_payment;
  assert.equal(c.librustzcashDecrypt.seller[0].transferType, "Incoming");
  assert.throws(() => readTransaction(c.txHex, seller.ufvk), /invalid consensus branch id 0x5437f330/);
});

for (const name of ["ironwood_v6_payment", "ironwood_v6_refund"]) {
  test(`known gap: Ironwood (${name}) cannot be parsed`, () => {
    const c = v.cases[name];
    assert.equal(c.librustzcashDecrypt.seller.length, 1);
    assert.throws(() => readTransaction(c.txHex, seller.ufvk), /Unknown transaction format/);
  });
}
