// Builds examples/memo-01 and examples/memo-broken from test/vectors/auction-round-memo.json
// (made by tools/gen-vectors in auction-memo mode). The same round as round-01, but every
// bidder wrote their own refund address inside their bid memo, so the disclosure carries no
// refund address list. Run: node tools/make-memo-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const v = JSON.parse(readFileSync(new URL("test/vectors/auction-round-memo.json", root), "utf8"));
const tx = (label: string) => {
  const t = v.transactions[label];
  return { txid: t.txid as string, height: t.height as number, txHex: t.txHex as string };
};
const id = (label: string) => v.transactions[label].txid as string;
const addr = (party: string) => v.parties[party].address as string;
const memo = (bid: string) => `refund:${v.lotId}:${id(bid)}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const LABELS = ["bid_alice", "bid_bob", "bid_carol", "bid_dave_late", "refund_alice_change", "refund_bob_change", "refund_carol", "refund_dave_late"];
const disclosure: Disclosure = {
  format: "imani-lot-disclosure/1",
  lotId: v.lotId,
  network: v.network,
  closeHeight: v.closeHeight,
  rules: v.rules,
  ufvk: v.parties["lot LOT-01"].ufvk,
  transactions: LABELS.map(tx),
};
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

for (const dir of ["memo-01", "memo-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("memo-01", disclosure, clone(result));

const FAKE_TXID = "f".repeat(8) + "0".repeat(56);
const broken: { name: string; story: string; changed: string; expected: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-extra-fake-bid",
    story: "The seller adds a bid of 1,200,000 that was never paid, and lists a refund for it.",
    expected: "bid-count",
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
    expected: "bid-amounts",
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
    expected: "refunds-paid",
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
    expected: "refunds-paid",
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
    expected: "winners-and-price",
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
    expected: "no-late-bids",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("bid_dave_late"), amountZat: 1_200_000 });
      r.bidCount = 4;
      r.refunds[3].reason = "loser";
      return [clone(disclosure), r];
    },
  },
  {
    name: "07-refund-to-other-address",
    expected: "refund-receivers",
    story:
      "Carol wrote her own address in her bid memo, but the refund the seller paid for her bid went to Dave's address. The amount and the memo naming the bid are right, so the older checks pass. Only the receiver check sees it.",
    changed: "disclosure.json (the refund transaction for Carol)",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("refund_carol") ? tx("refund_carol_elsewhere") : t));
      return [d, clone(result)];
    },
  },
  {
    name: "08-list-contradicts-bid-memo",
    expected: "refund-receivers",
    story:
      "The refunds are honest, but the seller adds a refund address list that names Dave's address for Carol's bid. Carol's own bid memo says otherwise, and the memo wins, so the checker fails the seller's list.",
    changed: "disclosure.json (an added refundAddresses list)",
    make: () => {
      const d = clone(disclosure);
      d.refundAddresses = [
        { bidTxid: id("bid_alice"), address: addr("bidder alice") },
        { bidTxid: id("bid_bob"), address: addr("bidder bob") },
        { bidTxid: id("bid_carol"), address: addr("bidder dave") },
        { bidTxid: id("bid_dave_late"), address: addr("bidder dave") },
      ];
      return [d, clone(result)];
    },
  },
];
for (const b of broken) {
  const [d, r] = b.make();
  write(`memo-broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/memo-broken/manifest.json", root),
  JSON.stringify(
    {
      about:
        "Broken copies of examples/memo-01, where each bidder wrote their refund address in their own bid memo. Copies 01 to 06 are the same six as examples/broken, each failing one named check. Copies 07 and 08 change where the refund went or add a contradicting seller list, and fail refund-receivers.",
      copies: broken.map(({ name, changed, story, expected }) => ({ name, changed, expectedFailingCheck: expected, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/memo-01 and examples/memo-broken (8 copies)");
