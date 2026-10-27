// Sealed lots keep the seller from reading a price before the close.
// Honest limit: whoever holds the lot key can read every payment as it lands, so "locked out"
// means no price arrives before the close. These tests show that for a sealed lot and, to prove
// the test is not empty, show that a plain lot gives every price away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot } from "../src/check.ts";
import { sealHash, type Disclosure, type SellerResult } from "../src/files.ts";
import { openSeals, type OpenFact, type SealFact } from "../src/sealed.ts";
import { earlyOpenings, pricesReadableAt, sellerViewAt } from "../src/seller-view.ts";

const root = new URL("../", import.meta.url);
const load = (dir: string): { d: Disclosure; r: SellerResult } => ({
  d: JSON.parse(readFileSync(new URL(`examples/${dir}/disclosure.json`, root), "utf8")),
  r: JSON.parse(readFileSync(new URL(`examples/${dir}/result.json`, root), "utf8")),
});

test("seller peek: at the close the lot key shows no price in a sealed lot, and every price in a plain lot", () => {
  const sealed = load("sealed-01");
  const plain = load("testnet-01");
  const view = sellerViewAt(sealed.d, sealed.d.closeHeight);
  const seals = view.filter((s) => s.kind === "seal");
  assert.ok(seals.length >= 5, "the seller does see the deposits");
  assert.ok(seals.every((s) => s.readablePriceZat === null), "no seal carries a readable price");
  assert.deepEqual(pricesReadableAt(sealed.d, sealed.d.closeHeight), []);
  assert.equal(view.filter((s) => s.kind === "opening").length, 0, "no opening has arrived by the close");
  const text = JSON.stringify(view);
  for (const b of sealed.r.bids) assert.ok(!text.includes(String(b.amountZat)), `price ${b.amountZat} visible at close`);
  // After the close the seller does read the opened prices.
  assert.ok(pricesReadableAt(sealed.d, sealed.d.closeHeight + 1000).length >= 3);
  // The test is not empty: in a plain lot every bid price is readable before the close.
  const seen = pricesReadableAt(plain.d, plain.d.closeHeight);
  assert.equal(seen.length, plain.r.bids.length);
  assert.deepEqual(seen.map((s) => s.priceZat).sort(), plain.r.bids.map((b) => b.amountZat).sort());
});

test("early open: an opening sent at or before the close never counts, and the early price is reported", () => {
  const manifest = JSON.parse(readFileSync(new URL("examples/sealed-locked-broken/manifest.json", root), "utf8"));
  const copy = manifest.copies.find((c: { name: string }) => c.name === "01-counts-early-opening");
  const { d, r } = load("sealed-locked-broken/01-counts-early-opening");
  const v = checkLot(d, r);
  assert.equal(v.result, "FAIL");
  assert.deepEqual(v.checks.filter((c) => c.status === "FAIL").map((c) => c.id).sort(), [...copy.expectedFailingChecks].sort());
  assert.ok(v.checks.some((c) => c.id === "seal-openings" && c.status === "FAIL"));
  const early = earlyOpenings(d);
  assert.equal(early.length, 1, "the seller could read one price before the close");
  assert.ok(early[0].readablePriceZat !== null);
  assert.equal(earlyOpenings(load("sealed-01").d).length, 0);
  // The pure rule: an opening at the close is a stray payment and the seal does not count.
  const LOT = "LOT-01";
  const salt = "00112233445566778899aabbccddeeff";
  const rules = { kind: "sealed" as const, itemCount: 1, reserveZat: 1, depositZat: 5_000_000, forfeitZat: 500_000 };
  const seal: SealFact = { txid: "a".repeat(64), height: 5, paidZat: 5_000_000, valid: true, word: "w1", hash: sealHash(LOT, "w1", 3_000_000, salt, null), address: null };
  const open: OpenFact = { txid: "b".repeat(64), height: 100, paidZat: 10_000, valid: true, word: "w1", amountZat: 3_000_000, salt };
  assert.equal(openSeals(LOT, rules, 100, 200, [seal], [open]).counted.length, 0);
  assert.equal(openSeals(LOT, rules, 100, 200, [seal], [{ ...open, height: 101 }]).counted.length, 1);
});

test("tampered commitment: changing any one part of a seal stops it counting", () => {
  const LOT = "LOT-01";
  const base = { word: "q7k2", amount: 3_000_000, salt: "00112233445566778899aabbccddeeff", address: null as string | null };
  const h = sealHash(LOT, base.word, base.amount, base.salt, base.address);
  const changes: [string, string][] = [
    ["lot", sealHash("LOT-02", base.word, base.amount, base.salt, null)],
    ["word", sealHash(LOT, "q7k3", base.amount, base.salt, null)],
    ["price", sealHash(LOT, base.word, 3_000_001, base.salt, null)],
    ["salt", sealHash(LOT, base.word, base.amount, "00112233445566778899aabbccddeefe", null)],
    ["address", sealHash(LOT, base.word, base.amount, base.salt, "utest1x")],
  ];
  for (const [what, changed] of changes) assert.notEqual(changed, h, what);
  // An opening with any one part changed moves the seal from counted to a bad opening.
  const rules = { kind: "sealed" as const, itemCount: 1, reserveZat: 1, depositZat: 5_000_000, forfeitZat: 500_000 };
  const seal: SealFact = { txid: "a".repeat(64), height: 5, paidZat: 5_000_000, valid: true, word: base.word, hash: h, address: null };
  const good: OpenFact = { txid: "b".repeat(64), height: 150, paidZat: 10_000, valid: true, word: base.word, amountZat: base.amount, salt: base.salt };
  assert.equal(openSeals(LOT, rules, 100, 200, [seal], [good]).counted.length, 1);
  for (const bad of [{ amountZat: 3_000_001 }, { salt: "00112233445566778899aabbccddeefe" }]) {
    const o = openSeals(LOT, rules, 100, 200, [seal], [{ ...good, ...bad }]);
    assert.equal(o.counted.length, 0);
    assert.equal(o.badOpen.length, 1);
  }
  // Checker level: the seller counts a seal whose opening did not match it.
  const { d, r } = load("sealed-locked-broken/02-tampered-commitment");
  const v = checkLot(d, r);
  assert.equal(v.result, "FAIL");
  assert.ok(v.checks.some((c) => c.id === "seal-openings" && c.status === "FAIL"));
});

test("the new sealed copies change nothing in the shipped sealed round", () => {
  const { d, r } = load("sealed-01");
  assert.equal(checkLot(d, r).result, "PASS");
});
