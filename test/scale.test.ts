// Locked answers for a round the size of the year's largest Zcash auction (16,971 counted bids, 17,000
// payments in all). Written before the first run.
//   - The numbers are GENERATED to that size with a fixed seed. They are not real payments, so only the
//     basic level (no key, no chain) runs on them. Reading real transactions is measured separately.
//   - An honest result file for such a round passes, in well under 10 seconds.
//   - The same file with one bid left out, one refund changed or one published total moved by 1 fails.
//   - The winners, the price and the totals equal what an independent, plain sort-and-add gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkLot } from "../src/check.ts";
import { decide } from "../src/rules.ts";
import type { Disclosure, SellerResult } from "../src/files.ts";

const COUNTED = 16_971;
const LATE = 29;
const ITEMS = 5_000;
const RESERVE = 100_000_000; // 1 ZEC

// A small fixed-seed generator, so every run builds the same round.
let seed = 0x2f6e2b1;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const txid = (i: number) => createHash("sha256").update(`scale-bid-${i}`).digest("hex");

function build() {
  seed = 0x2f6e2b1;
  const lotId = "SCALE-01";
  const closeHeight = 3_000_000;
  const bids = Array.from({ length: COUNTED + LATE }, (_, i) => ({
    txid: txid(i),
    // 0.5 to 5.5 ZEC in whole zatoshis. Ties happen on purpose.
    amountZat: 50_000_000 + (next() % 501) * 1_000_000,
    height: i < COUNTED ? 2_990_000 + (i % 9_000) : closeHeight + 1 + (i % 50),
  }));
  const onTime = bids.filter((b) => b.height <= closeHeight);
  const late = bids.filter((b) => b.height > closeHeight);
  const rules = { itemCount: ITEMS, reserveZat: RESERVE, pricing: "lowest-winning" as const };
  const out = decide(onTime, rules);
  const winnerSet = new Set(out.winners);
  const refunds = [
    ...onTime
      .filter((b) => (out.refundsOwed.get(b.txid) ?? 0) > 0)
      .map((b) => ({ bidTxid: b.txid, amountZat: out.refundsOwed.get(b.txid)!, reason: (winnerSet.has(b.txid) ? "change" : "loser") as "change" | "loser", memo: `refund:${lotId}:${b.txid}` })),
    ...late.map((b) => ({ bidTxid: b.txid, amountZat: b.amountZat, reason: "late" as const, memo: `refund:${lotId}:${b.txid}` })),
  ];
  const received = bids.reduce((s, b) => s + b.amountZat, 0);
  const refunded = refunds.reduce((s, f) => s + f.amountZat, 0);
  const d: Disclosure = { format: "imani-lot-disclosure/1", lotId, network: "main", closeHeight, rules, transactions: [] };
  const r: SellerResult = {
    format: "imani-lot-result/1",
    lotId,
    rules,
    bidCount: onTime.length,
    bids: onTime.map((b) => ({ txid: b.txid, amountZat: b.amountZat })),
    winners: out.winners,
    clearingPriceZat: out.clearingPriceZat,
    reserveMet: out.reserveMet,
    refunds,
    totals: { payments: bids.length, receivedZat: received, keptZat: received - refunded, refundedZat: refunded },
  };
  return { d, r, bids, onTime, out };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const run = (d: Disclosure, r: SellerResult) => checkLot(d, r, { basicOnly: true });

test("the generated round has the published size", () => {
  const { bids, onTime } = build();
  assert.equal(bids.length, 17_000);
  assert.equal(onTime.length, 16_971);
});

test("an honest 17,000-payment round passes the basic level, with its totals, in under 10 seconds", () => {
  const { d, r } = build();
  const t0 = Date.now();
  const v = run(d, r);
  const ms = Date.now() - t0;
  assert.equal(v.result, "PASS", v.failed.join(", "));
  assert.ok(v.checks.some((c) => c.id === "published-totals" && c.status === "PASS"));
  assert.ok(ms < 10_000, `took ${ms} ms`);
  console.log(`scale: basic level on 17,000 payments took ${ms} ms`);
});

test("winners, price and totals equal an independent sort-and-add", () => {
  const { r, onTime } = build();
  const ranked = onTime
    .filter((b) => b.amountZat >= RESERVE)
    .sort((a, b) => b.amountZat - a.amountZat || a.height - b.height || (a.txid < b.txid ? -1 : 1))
    .slice(0, ITEMS);
  assert.deepEqual([...r.winners].sort(), ranked.map((b) => b.txid).sort());
  assert.equal(r.clearingPriceZat, ranked[ranked.length - 1].amountZat);
  const received = onTime.reduce((s, b) => s + b.amountZat, 0) + build().bids.slice(COUNTED).reduce((s, b) => s + b.amountZat, 0);
  assert.equal(r.totals!.receivedZat, received);
  assert.equal(r.totals!.keptZat, r.clearingPriceZat * ITEMS);
  assert.equal(r.totals!.receivedZat, r.totals!.keptZat + r.totals!.refundedZat);
});

test("one change anywhere in a 17,000-payment round makes it fail", () => {
  const { d, r } = build();
  const changes: [string, (x: SellerResult) => void][] = [
    ["a winner's bid left out", (x) => { x.bids.splice(x.bids.findIndex((b) => b.txid === x.winners[0]), 1); }],
    ["one refund one zatoshi higher", (x) => { x.refunds[1234].amountZat += 1; }],
    ["one refund left out", (x) => { x.refunds.splice(777, 1); }],
    ["the price one zatoshi higher", (x) => { x.clearingPriceZat += 1; }],
    ["the published payments one lower than the payments the lists show", (x) => { x.totals!.payments = COUNTED + LATE - 1; }],
    ["the published kept one higher", (x) => { x.totals!.keptZat += 1; }],
    ["a winner dropped", (x) => { x.winners.pop(); }],
  ];
  for (const [name, apply] of changes) {
    const x = clone(r);
    apply(x);
    assert.equal(run(d, x).result, "FAIL", name);
  }
});
