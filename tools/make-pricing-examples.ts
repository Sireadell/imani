// Builds examples/pricing-01 and examples/pricing-broken from the same made-up chain as round-01
// (test/vectors/auction-round.json). Run: node tools/make-pricing-examples.ts
// The lot sells 3 items under the "lowest-winning" rule: every winner pays the lowest bid that won.
// Bids of 3,000,000, 2,000,000 and 1,500,000 come in on time, so all three win and the price is
// 1,500,000 (Carol's bid), the same refunds the chain already shows for Alice and Bob. Under the
// default rule the same bids would have cost 1,000,000 each. Dave's 1,200,000 is late and goes back.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const v = JSON.parse(readFileSync(new URL("test/vectors/auction-round.json", root), "utf8"));
const tx = (label: string) => {
  const t = v.transactions[label];
  return { txid: t.txid as string, height: t.height as number, txHex: t.txHex as string };
};
const id = (label: string) => v.transactions[label].txid as string;
const memo = (bid: string) => `refund:${v.lotId}:${id(bid)}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const rules = { itemCount: 3, reserveZat: 1_000_000, pricing: "lowest-winning" as const };
const disclosure: Disclosure = {
  format: "imani-lot-disclosure/1",
  lotId: v.lotId,
  network: v.network,
  closeHeight: v.closeHeight,
  rules,
  ufvk: v.parties["lot LOT-01"].ufvk,
  transactions: ["bid_alice", "bid_bob", "bid_carol", "bid_dave_late", "refund_alice_change", "refund_bob_change", "refund_dave_late"].map(tx),
};
// Written by hand: price 1,500,000. Alice gets 3,000,000 - 1,500,000 back, Bob 2,000,000 - 1,500,000, Carol nothing.
const result: SellerResult = {
  format: "imani-lot-result/1",
  lotId: v.lotId,
  rules,
  bidCount: 3,
  bids: [
    { txid: id("bid_alice"), amountZat: 3_000_000 },
    { txid: id("bid_bob"), amountZat: 2_000_000 },
    { txid: id("bid_carol"), amountZat: 1_500_000 },
  ],
  winners: [id("bid_alice"), id("bid_bob"), id("bid_carol")],
  clearingPriceZat: 1_500_000,
  reserveMet: true,
  refunds: [
    { bidTxid: id("bid_alice"), amountZat: 1_500_000, reason: "change", memo: memo("bid_alice") },
    { bidTxid: id("bid_bob"), amountZat: 500_000, reason: "change", memo: memo("bid_bob") },
    { bidTxid: id("bid_dave_late"), amountZat: 1_200_000, reason: "late", memo: memo("bid_dave_late") },
  ],
};

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};
for (const dir of ["pricing-01", "pricing-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("pricing-01", disclosure, clone(result));

const broken: { name: string; story: string; expectedFailingChecks: string[]; changed: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-uses-the-other-price-rule",
    story: "The lot says winners pay the lowest winning bid, 1,500,000. The seller's result charges 1,000,000, the price the default rule would give for these bids.",
    expectedFailingChecks: ["clearing-range", "refund-total", "winners-and-price"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.clearingPriceZat = 1_000_000;
      return [clone(disclosure), r];
    },
  },
  {
    name: "02-rule-changed-in-the-result",
    story: "The disclosure says the lowest winning bid sets the price. The seller's result file quotes the other rule, the highest losing bid.",
    expectedFailingChecks: ["result-consistent"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.rules = { itemCount: 3, reserveZat: 1_000_000, pricing: "highest-losing" };
      return [clone(disclosure), r];
    },
  },
  {
    name: "03-rule-dropped-from-the-disclosure",
    story: "The seller's disclosure no longer says which price rule the lot ran under, so the checker applies the default rule while the result was built on the lowest winning bid.",
    expectedFailingChecks: ["refunds-paid", "result-consistent", "winners-and-price"],
    changed: "disclosure.json",
    make: () => {
      const d = clone(disclosure);
      d.rules = { itemCount: 3, reserveZat: 1_000_000 };
      return [d, clone(result)];
    },
  },
  {
    name: "04-leaves-out-the-lowest-winner",
    story: "Carol's 1,500,000 is on the chain but the seller's list leaves it out and raises the price to Bob's bid, 2,000,000.",
    expectedFailingChecks: ["bid-count", "refund-total", "winners-and-price"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bidCount = 2;
      r.bids = r.bids.slice(0, 2);
      r.winners = r.winners.slice(0, 2);
      r.clearingPriceZat = 2_000_000;
      r.refunds = [
        { bidTxid: id("bid_alice"), amountZat: 1_000_000, reason: "change", memo: memo("bid_alice") },
        { bidTxid: id("bid_dave_late"), amountZat: 1_200_000, reason: "late", memo: memo("bid_dave_late") },
      ];
      return [clone(disclosure), r];
    },
  },
  {
    name: "05-lists-a-smaller-refund-for-a-winner",
    story: "Alice's change on the chain is 1,500,000. The seller's books list 1,000,000, as if the price were 2,000,000 for her.",
    expectedFailingChecks: ["refund-total"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.refunds[0].amountZat = 1_000_000;
      return [clone(disclosure), r];
    },
  },
];
for (const b of broken) {
  const [d, r] = b.make();
  write(`pricing-broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/pricing-broken/manifest.json", root),
  JSON.stringify(
    {
      about: "Broken copies of examples/pricing-01, a lot where winners pay the lowest winning bid. Each copy is a different cheat and fails on the checks listed.",
      copies: broken.map(({ name, changed, expectedFailingChecks, story }) => ({ name, changed, expectedFailingCheck: expectedFailingChecks[0], expectedFailingChecks, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/pricing-01 and examples/pricing-broken (5 copies)");
