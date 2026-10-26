// Builds examples/totals-01 and examples/totals-broken from the same made-up chain as round-01
// (test/vectors/auction-round.json). Run: node tools/make-totals-examples.ts
// The seller publishes headline numbers next to the result: payments, received, kept, refunded.
// Round-01: 4 bid payments (one late) of 7,700,000 in all. Two winners pay 1,500,000 each, so the seller
// keeps 3,000,000 and 4,700,000 goes back. Received = kept + refunded.
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

const disclosure: Disclosure = {
  format: "imani-lot-disclosure/1",
  lotId: v.lotId,
  network: v.network,
  closeHeight: v.closeHeight,
  rules: v.rules,
  ufvk: v.parties["lot LOT-01"].ufvk,
  transactions: ["bid_alice", "bid_bob", "bid_carol", "bid_dave_late", "refund_alice_change", "refund_bob_change", "refund_carol", "refund_dave_late"].map(tx),
};
// Written by hand, not by the checker's code.
const result: SellerResult = {
  format: "imani-lot-result/1",
  lotId: v.lotId,
  rules: v.rules,
  bidCount: 3,
  bids: [
    { txid: id("bid_alice"), amountZat: 3_000_000 },
    { txid: id("bid_bob"), amountZat: 2_000_000 },
    { txid: id("bid_carol"), amountZat: 1_500_000 },
  ],
  winners: [id("bid_alice"), id("bid_bob")],
  clearingPriceZat: 1_500_000,
  reserveMet: true,
  refunds: [
    { bidTxid: id("bid_alice"), amountZat: 1_500_000, reason: "change", memo: memo("bid_alice") },
    { bidTxid: id("bid_bob"), amountZat: 500_000, reason: "change", memo: memo("bid_bob") },
    { bidTxid: id("bid_carol"), amountZat: 1_500_000, reason: "loser", memo: memo("bid_carol") },
    { bidTxid: id("bid_dave_late"), amountZat: 1_200_000, reason: "late", memo: memo("bid_dave_late") },
  ],
  totals: { payments: 4, receivedZat: 7_700_000, keptZat: 3_000_000, refundedZat: 4_700_000 },
};

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};
for (const dir of ["totals-01", "totals-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("totals-01", disclosure, clone(result));

const withTotals = (t: Partial<NonNullable<SellerResult["totals"]>>): [Disclosure, SellerResult] => {
  const r = clone(result);
  r.totals = { ...r.totals!, ...t };
  return [clone(disclosure), r];
};
const broken: { name: string; story: string; expectedFailingChecks: string[]; changed: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-keeps-more-than-the-winners-paid",
    story: "The seller publishes that 3,500,000 was kept and 4,200,000 refunded. Both add up to the 7,700,000 received, but two winners at 1,500,000 pay 3,000,000, and 4,700,000 was refunded.",
    expectedFailingChecks: ["published-totals", "published-totals-chain"],
    changed: "result.json",
    make: () => withTotals({ keptZat: 3_500_000, refundedZat: 4_200_000 }),
  },
  {
    name: "02-hides-a-payment",
    story: "Four payments reached the lot, one of them late. The seller publishes three, fewer than the three bids and the one late payment its own lists show.",
    expectedFailingChecks: ["published-totals", "published-totals-chain"],
    changed: "result.json",
    make: () => withTotals({ payments: 3 }),
  },
  {
    name: "03-totals-do-not-balance",
    story: "The seller publishes 7,800,000 received, 100,000 more than came in, so received no longer equals kept plus refunded.",
    expectedFailingChecks: ["published-totals", "published-totals-chain"],
    changed: "result.json",
    make: () => withTotals({ receivedZat: 7_800_000 }),
  },
  {
    name: "04-refund-list-is-shorter-than-the-total",
    story: "The seller publishes the true total refunded, 4,700,000, but the refund list leaves out the 1,200,000 owed to the late bidder, so the books do not balance.",
    expectedFailingChecks: ["published-totals", "refund-total"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.refunds = r.refunds.filter((f) => f.reason !== "late");
      return [clone(disclosure), r];
    },
  },
];
for (const b of broken) {
  const [d, r] = b.make();
  write(`totals-broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/totals-broken/manifest.json", root),
  JSON.stringify(
    {
      about: "Broken copies of examples/totals-01, a round whose seller published headline totals. Each copy changes the totals or the refund list and fails on the checks listed.",
      copies: broken.map(({ name, changed, expectedFailingChecks, story }) => ({ name, changed, expectedFailingCheck: expectedFailingChecks[0], expectedFailingChecks, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/totals-01 and examples/totals-broken (4 copies)");
