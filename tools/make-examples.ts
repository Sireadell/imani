// Builds examples/round-01 and examples/broken from test/vectors/auction-round.json
// (made by tools/gen-vectors in auction mode). Run: node tools/make-examples.ts
// Output is deterministic: same input file, same example files.
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
  transactions: [
    "bid_alice",
    "bid_bob",
    "bid_carol",
    "bid_dave_late",
    "refund_alice_change",
    "refund_bob_change",
    "refund_carol",
    "refund_dave_late",
  ].map(tx),
};

// The honest result, written out by hand (not computed by the checker's own code).
// 2 items, reserve 1,000,000. Bids 3,000,000 / 2,000,000 / 1,500,000 on time, 1,200,000 late.
// Top two win. Clearing price = highest losing bid = 1,500,000.
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
};

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};

// Remove only the folders this script writes; scan examples come from tools/make-scan-examples.ts.
for (const dir of ["round-01", "broken", "guards"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("round-01", disclosure, result);

const FAKE_TXID = "f".repeat(8) + "0".repeat(56);
const broken: { name: string; story: string; expectedFailingCheck: string; changed: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-extra-fake-bid",
    story: "The seller adds a bid of 1,200,000 that was never paid, and lists a refund for it.",
    expectedFailingCheck: "bid-count",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: FAKE_TXID, amountZat: 1_200_000 });
      r.bidCount = 4;
      r.refunds.push({ bidTxid: FAKE_TXID, amountZat: 1_200_000, reason: "loser", memo: `refund:${v.lotId}:${FAKE_TXID}` });
      return [clone(disclosure), r];
    },
  },
  {
    name: "02-wrong-bid-amount",
    story: "The seller reports Alice's bid as 2,900,000. The chain shows 3,000,000.",
    expectedFailingCheck: "bid-amounts",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids[0].amountZat = 2_900_000;
      return [clone(disclosure), r];
    },
  },
  {
    name: "03-missing-refund",
    story: "Carol lost but her refund was never sent. The seller's file still lists it.",
    expectedFailingCheck: "refunds-paid",
    changed: "disclosure.json",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.filter((t) => t.txid !== id("refund_carol"));
      return [d, clone(result)];
    },
  },
  {
    name: "04-short-refund",
    story: "Carol lost and was refunded 1,400,000 instead of her full 1,500,000. The seller's file says 1,500,000.",
    expectedFailingCheck: "refunds-paid",
    changed: "disclosure.json",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("refund_carol") ? tx("refund_carol_short") : t));
      return [d, clone(result)];
    },
  },
  {
    name: "05-wrong-clearing-price",
    story: "The seller says winners pay 1,600,000 each instead of 1,500,000, and shrinks the winners' change to match.",
    expectedFailingCheck: "winners-and-price",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.clearingPriceZat = 1_600_000;
      r.refunds[0].amountZat = 1_400_000;
      r.refunds[1].amountZat = 400_000;
      return [clone(disclosure), r];
    },
  },
  {
    name: "06-late-bid-counted",
    story: "Dave's bid arrived 5 blocks after the close. The seller counts it as a losing bid anyway.",
    expectedFailingCheck: "no-late-bids",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("bid_dave_late"), amountZat: 1_200_000 });
      r.bidCount = 4;
      r.refunds[3].reason = "loser";
      return [clone(disclosure), r];
    },
  },
];

for (const b of broken) {
  const [d, r] = b.make();
  write(`broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/broken/manifest.json", root),
  JSON.stringify(
    {
      about: "Broken copies of examples/round-01. Each one changes one thing and must FAIL on exactly one check.",
      copies: broken.map(({ name, story, expectedFailingCheck, changed }) => ({ name, changed, expectedFailingCheck, story })),
    },
    null,
    2,
  ) + "\n",
);

// Guard cases, used by the tests: payments outside the lot, and a replayed bid.
const withExtra = (label: string): Disclosure => {
  const d = clone(disclosure);
  d.transactions.splice(3, 0, tx(label));
  return d;
};
write("guards/outside-payment", withExtra("stray_payment"), clone(result));
write("guards/other-lot-bid", withExtra("bid_other_lot"), clone(result));
write("guards/replayed-bid", withExtra("bid_alice_replay"), clone(result));

console.log("wrote examples/round-01, examples/broken (6 copies) and examples/guards");
