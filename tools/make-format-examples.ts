// Builds examples/formats-01: three one-item rounds that show the auction formats which the
// bigger examples only imply. Run: node tools/make-format-examples.ts
// All three reuse the made-up chain of round-01 (test/vectors/auction-round.json), so no key is used.
//   second-price      1 item, the winner pays the highest losing bid (Vickrey, Imani's default rule)
//   first-price       1 item, the winner pays their own bid ("lowest-winning" with one item)
//   top-up            1 item, first price, a bidder raises their bid by paying again under the same memo
// Each has one broken copy where the seller applies the wrong rule.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const v = JSON.parse(readFileSync(new URL("test/vectors/auction-round.json", root), "utf8"));
const tx = (label: string) => {
  const t = v.transactions[label];
  return { txid: t.txid as string, height: t.height as number, txHex: t.txHex as string };
};
const id = (label: string) => v.transactions[label].txid as string;
const refund = (bid: string, amountZat: number, reason: "change" | "loser" | "late") => ({ bidTxid: id(bid), amountZat, reason, memo: `refund:${v.lotId}:${id(bid)}` });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

type Rules = NonNullable<SellerResult["rules"]>;
const round = (rules: Rules, txs: string[], bids: [string, number][], winner: string, price: number, refunds: SellerResult["refunds"]): [Disclosure, SellerResult] => [
  {
    format: "imani-lot-disclosure/1",
    lotId: v.lotId,
    network: v.network,
    closeHeight: v.closeHeight,
    rules,
    ufvk: v.parties["lot LOT-01"].ufvk,
    transactions: txs.map(tx),
  },
  {
    format: "imani-lot-result/1",
    lotId: v.lotId,
    rules,
    bidCount: bids.length,
    bids: bids.map(([l, amountZat]) => ({ txid: id(l), amountZat })),
    winners: [id(winner)],
    clearingPriceZat: price,
    reserveMet: true,
    refunds,
  },
];

// Alice bids 3,000,000, Carol 1,500,000 and Dave 1,200,000 too late. One item, reserve 1,000,000.
const second = round(
  { itemCount: 1, reserveZat: 1_000_000, pricing: "highest-losing" },
  ["bid_alice", "bid_carol", "bid_dave_late", "refund_alice_change", "refund_carol", "refund_dave_late"],
  [["bid_alice", 3_000_000], ["bid_carol", 1_500_000]],
  "bid_alice",
  1_500_000,
  [refund("bid_alice", 1_500_000, "change"), refund("bid_carol", 1_500_000, "loser"), refund("bid_dave_late", 1_200_000, "late")],
);
const first = round(
  { itemCount: 1, reserveZat: 1_000_000, pricing: "lowest-winning" },
  ["bid_alice", "bid_carol", "bid_dave_late", "refund_carol", "refund_dave_late"],
  [["bid_alice", 3_000_000], ["bid_carol", 1_500_000]],
  "bid_alice",
  3_000_000,
  [refund("bid_carol", 1_500_000, "loser"), refund("bid_dave_late", 1_200_000, "late")],
);
// Alice pays 3,000,000 at block 4200010 and another 3,000,000 under the same memo at block 4200060.
const topUp = round(
  { itemCount: 1, reserveZat: 1_000_000, pricing: "lowest-winning", topUps: true },
  ["bid_alice", "bid_alice_replay", "bid_carol", "bid_dave_late", "refund_carol", "refund_dave_late"],
  [["bid_alice", 6_000_000], ["bid_carol", 1_500_000]],
  "bid_alice",
  6_000_000,
  [refund("bid_carol", 1_500_000, "loser"), refund("bid_dave_late", 1_200_000, "late")],
);

const write = (dir: string, [d, r]: [Disclosure, SellerResult]) => {
  const u = new URL(`examples/formats-01/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), json(d));
  writeFileSync(new URL("result.json", u), json(r));
};

rmSync(new URL("examples/formats-01/", root), { recursive: true, force: true });
write("second-price", second);
write("first-price", first);
write("top-up", topUp);

const wrongPrice = (r: [Disclosure, SellerResult], price: number): [Disclosure, SellerResult] => {
  const c = clone(r);
  c[1].clearingPriceZat = price;
  return c;
};
// The seller charges the winner their own bid, not the second price: no change is sent back.
{
  const c = wrongPrice(second, 3_000_000);
  c[1].refunds = c[1].refunds.filter((f) => f.reason !== "change");
  write("second-price-broken", c);
}
// The seller charges the winner only the highest losing bid under a first-price rule.
{
  const c = wrongPrice(first, 1_500_000);
  c[1].refunds = [refund("bid_alice", 1_500_000, "change"), ...c[1].refunds];
  write("first-price-broken", c);
}
// The seller counts only Alice's first payment and ignores the top-up.
{
  const c = clone(topUp);
  c[1].bids[0].amountZat = 3_000_000;
  c[1].clearingPriceZat = 3_000_000;
  write("top-up-broken", c);
}

writeFileSync(
  new URL("examples/formats-01/manifest.json", root),
  json({
    about: "One-item rounds for the formats the larger examples only imply. Each folder is an honest round that must PASS, and each *-broken folder is a copy where the seller applied the wrong rule or ignored a top-up, which must FAIL on the checks listed.",
    rounds: [
      { name: "second-price", expect: "PASS", story: "One item, the winner pays the highest losing bid (Vickrey)." },
      { name: "first-price", expect: "PASS", story: "One item, the winner pays their own bid." },
      { name: "top-up", expect: "PASS", story: "One item, first price. Alice pays 3,000,000 and later 3,000,000 more under the same memo, so her bid is 6,000,000." },
      { name: "second-price-broken", expect: "FAIL", failing: ["winners-and-price"], story: "The seller charges the second-price winner their whole bid, 3,000,000, and sends no change, instead of the highest losing bid, 1,500,000." },
      { name: "first-price-broken", expect: "FAIL", failing: ["clearing-range", "winners-and-price"], story: "The seller charges the first-price winner only the highest losing bid." },
      { name: "top-up-broken", expect: "FAIL", failing: ["bid-amounts", "winners-and-price", "refund-total"], story: "The seller counts only the first of Alice's two payments, so her bid looks like 3,000,000 instead of 6,000,000." },
    ],
  }),
);
console.log("wrote examples/formats-01 (3 honest rounds, 3 broken copies)");
