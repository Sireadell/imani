// Locked answers for the two price rules and for bid top-ups. Written before the example rounds.
// Highest-losing (the default): winners pay the highest bid that did not win, never below the reserve.
// Lowest-winning: winners pay the lowest bid that won, so the last bidder in pays exactly their bid.
// Top-ups: payments under one bid memo that arrive by the close add up to one bid, counted at the
// first payment's id and ranked at the block of the last payment. A payment after the close never joins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, groupBidPayments, type BidPayment } from "../src/rules.ts";

const bid = (txid: string, amountZat: number, height = 10) => ({ txid, amountZat, height });
const pay = (txid: string, memo: string, amountZat: number, height: number): BidPayment => ({ txid, memo, amountZat, height, outputs: 1 });

test("lowest-winning: two items, bids 300, 200, 150 and reserve 100 give a price of 200", () => {
  const rules = { itemCount: 2, reserveZat: 100, pricing: "lowest-winning" as const };
  const out = decide([bid("a", 300), bid("b", 200), bid("c", 150)], rules);
  assert.equal(out.clearingPriceZat, 200);
  assert.deepEqual(out.winners, ["a", "b"]);
  assert.equal(out.refundsOwed.get("a"), 100);
  assert.equal(out.refundsOwed.get("b"), 0);
  assert.equal(out.refundsOwed.get("c"), 150);
  // the default rule on the same bids is unchanged
  assert.equal(decide([bid("a", 300), bid("b", 200), bid("c", 150)], { itemCount: 2, reserveZat: 100 }).clearingPriceZat, 150);
  assert.equal(decide([bid("a", 300), bid("b", 200), bid("c", 150)], { itemCount: 2, reserveZat: 100, pricing: "highest-losing" }).clearingPriceZat, 150);
});

test("lowest-winning: fewer bids than items, the price is the lowest bid, not the reserve", () => {
  const out = decide([bid("a", 300), bid("b", 200)], { itemCount: 5, reserveZat: 100, pricing: "lowest-winning" });
  assert.equal(out.clearingPriceZat, 200);
  assert.deepEqual(out.winners, ["a", "b"]);
});

test("lowest-winning: bids under the reserve never win and no winners means price 0", () => {
  const rules = { itemCount: 2, reserveZat: 100, pricing: "lowest-winning" as const };
  const some = decide([bid("a", 300), bid("b", 90)], rules);
  assert.deepEqual(some.winners, ["a"]);
  assert.equal(some.clearingPriceZat, 300);
  const none = decide([bid("a", 90), bid("b", 80)], rules);
  assert.deepEqual(none.winners, []);
  assert.equal(none.clearingPriceZat, 0);
  assert.equal(none.refundsOwed.get("a"), 90);
});

test("lowest-winning: ties are broken by earlier block, then lower id, and the price is the tied amount", () => {
  const out = decide([bid("x", 200, 9), bid("y", 200, 3), bid("z", 300)], { itemCount: 2, reserveZat: 100, pricing: "lowest-winning" });
  assert.deepEqual(out.winners, ["z", "y"]);
  assert.equal(out.clearingPriceZat, 200);
});

test("money balances under both rules: refunds plus price times winners equals what came in", () => {
  for (const pricing of ["highest-losing", "lowest-winning"] as const) {
    const bids = [bid("a", 700), bid("b", 500), bid("c", 500, 11), bid("d", 120), bid("e", 50)];
    const out = decide(bids, { itemCount: 2, reserveZat: 100, pricing });
    const refunds = [...out.refundsOwed.values()].reduce((s, n) => s + n, 0);
    assert.equal(refunds + out.clearingPriceZat * out.winners.length, 700 + 500 + 500 + 120 + 50, pricing);
  }
});

test("top-ups off: a repeated memo is a replay and never adds to the bid", () => {
  const g = groupBidPayments([pay("t1", "bid:L:aa", 100, 5), pay("t2", "bid:L:aa", 50, 6)], false, 100);
  assert.deepEqual(g.bids.map((b) => [b.txid, b.amountZat]), [["t1", 100]]);
  assert.deepEqual(g.replays.map((b) => b.txid), ["t2"]);
});

test("top-ups on: on-time payments under one memo add up, counted at the first id and the last block", () => {
  const g = groupBidPayments([pay("t1", "bid:L:aa", 100, 5), pay("t2", "bid:L:bb", 70, 6), pay("t3", "bid:L:aa", 50, 9), pay("t4", "bid:L:aa", 25, 12)], true, 100);
  assert.deepEqual(g.replays, []);
  assert.deepEqual(g.bids.map((b) => [b.txid, b.amountZat, b.height]), [["t1", 175, 12], ["t2", 70, 6]]);
});

test("top-ups on: a payment after the close stands alone as a late bid, even under a known memo", () => {
  const g = groupBidPayments([pay("t1", "bid:L:aa", 100, 5), pay("t2", "bid:L:aa", 40, 101)], true, 100);
  assert.deepEqual(g.bids.map((b) => [b.txid, b.amountZat, b.height]), [["t1", 100, 5], ["t2", 40, 101]]);
});

test("top-ups on: grouping does not change the payments it was given", () => {
  const input = [pay("t1", "bid:L:aa", 100, 5), pay("t3", "bid:L:aa", 50, 9)];
  groupBidPayments(input, true, 100);
  assert.equal(input[0].amountZat, 100);
});

test("a bidder who tops up to a tie ranks behind the earlier equal bid", () => {
  const g = groupBidPayments([pay("t1", "bid:L:aa", 100, 5), pay("t2", "bid:L:bb", 200, 6), pay("t3", "bid:L:aa", 100, 9)], true, 100);
  const out = decide(g.bids, { itemCount: 1, reserveZat: 50, pricing: "lowest-winning", topUps: true });
  assert.deepEqual(out.winners, ["t2"]);
  assert.equal(out.clearingPriceZat, 200);
});

// ---- Top-ups on real transactions ----
// The test vectors hold two real payments with Alice's bid memo, 3,000,000 each, before the close. With top-ups
// on they are one bid of 6,000,000, counted at the id of the first payment. Two items, lowest-winning: Alice
// (6,000,000) and Bob (2,000,000) win, the price is 2,000,000, Alice gets 4,000,000 back and Carol 1,500,000.
// The vectors hold no refunds for those amounts, so refunds-paid is the one check that must fail here.
import { readFileSync } from "node:fs";
import { checkLot } from "../src/check.ts";
import type { Disclosure, SellerResult } from "../src/files.ts";

const vec = JSON.parse(readFileSync(new URL("./vectors/auction-round.json", import.meta.url), "utf8"));
const tx = (l: string) => ({ txid: vec.transactions[l].txid as string, height: vec.transactions[l].height as number, txHex: vec.transactions[l].txHex as string });
const id = (l: string) => vec.transactions[l].txid as string;
const topUpRound = (topUps: boolean) => {
  const rules = { itemCount: 2, reserveZat: 1_000_000, pricing: "lowest-winning" as const, ...(topUps ? { topUps: true } : {}) };
  const d: Disclosure = {
    format: "imani-lot-disclosure/1", lotId: vec.lotId, network: vec.network, closeHeight: vec.closeHeight, rules,
    ufvk: vec.parties["lot LOT-01"].ufvk, transactions: ["bid_alice", "bid_alice_replay", "bid_bob", "bid_carol"].map(tx),
  };
  const refund = (l: string, amountZat: number, reason: "change" | "loser") => ({ bidTxid: id(l), amountZat, reason, memo: `refund:${vec.lotId}:${id(l)}` });
  const r: SellerResult = {
    format: "imani-lot-result/1", lotId: vec.lotId, rules, bidCount: 3,
    bids: [{ txid: id("bid_alice"), amountZat: 6_000_000 }, { txid: id("bid_bob"), amountZat: 2_000_000 }, { txid: id("bid_carol"), amountZat: 1_500_000 }],
    winners: [id("bid_alice"), id("bid_bob")], clearingPriceZat: 2_000_000, reserveMet: true,
    refunds: [refund("bid_alice", 4_000_000, "change"), refund("bid_carol", 1_500_000, "loser")],
  };
  return { d, r };
};
const status = (v: ReturnType<typeof checkLot>, checkId: string) => v.checks.find((c) => c.id === checkId)?.status;

test("top-ups on, real payments: two payments under one memo are one bid of 6,000,000", () => {
  const { d, r } = topUpRound(true);
  const v = checkLot(d, r);
  for (const c of ["bid-count", "bid-amounts", "no-duplicate-bids", "winners-and-price", "reserve", "refund-total", "key-hygiene"]) assert.equal(status(v, c), "PASS", c);
  assert.deepEqual(v.failed, ["refunds-paid"]);
  assert.match(v.checks.find((c) => c.id === "no-duplicate-bids")!.reason, /1 extra payment\(s\) .* added to that bid/);
});

test("top-ups off, same payments: the second payment is a replay and the bid stays 3,000,000", () => {
  const { d, r } = topUpRound(false);
  const v = checkLot(d, r);
  assert.equal(status(v, "no-duplicate-bids"), "FAIL");
  assert.equal(status(v, "bid-amounts"), "FAIL");
});

test("top-ups on: a seller who counts only the first payment fails the amount check", () => {
  const { d, r } = topUpRound(true);
  r.bids[0].amountZat = 3_000_000;
  const v = checkLot(d, r);
  assert.equal(status(v, "bid-amounts"), "FAIL");
});

test("top-ups on: a seller who lists the second payment as its own bid fails the bid count", () => {
  const { d, r } = topUpRound(true);
  r.bids.push({ txid: id("bid_alice_replay"), amountZat: 3_000_000 });
  r.bidCount = 4;
  const v = checkLot(d, r);
  assert.equal(status(v, "bid-count"), "FAIL");
});

test("a result that turns top-ups on when the disclosure has them off is a different rule set", () => {
  const { d, r } = topUpRound(false);
  r.rules = { ...(r.rules as object), topUps: true } as SellerResult["rules"];
  assert.equal(status(checkLot(d, r), "result-consistent"), "FAIL");
});

// ---- The lowest-winning example round ----
test("pricing-01 passes every check and each of its five broken copies fails exactly the checks named", () => {
  const rd = (p: string) => JSON.parse(readFileSync(new URL(`../examples/${p}`, import.meta.url), "utf8"));
  const honest = checkLot(rd("pricing-01/disclosure.json"), rd("pricing-01/result.json"));
  assert.equal(honest.result, "PASS", honest.failed.join(", "));
  assert.equal(honest.checks.find((c) => c.id === "clearing-range")!.reason.includes("lowest listed winning bid"), true);
  const manifest = rd("pricing-broken/manifest.json");
  assert.equal(manifest.copies.length, 5);
  for (const c of manifest.copies) {
    const v = checkLot(rd(`pricing-broken/${c.name}/disclosure.json`), rd(`pricing-broken/${c.name}/result.json`));
    assert.equal(v.result, "FAIL", c.name);
    assert.deepEqual([...v.failed].sort(), [...c.expectedFailingChecks].sort(), c.name);
  }
});
