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

const broken: { name: string; story: string; changed: string; make: () => Disclosure }[] = [
  {
    name: "01-refund-to-other-address",
    story:
      "Carol wrote her own address in her bid memo, but the refund the seller paid for her bid went to Dave's address. The amount and the memo naming the bid are right, so the older checks pass. Only the receiver check sees it.",
    changed: "disclosure.json (the refund transaction for Carol)",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("refund_carol") ? tx("refund_carol_elsewhere") : t));
      return d;
    },
  },
  {
    name: "02-list-contradicts-bid-memo",
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
      return d;
    },
  },
];
for (const b of broken) write(`memo-broken/${b.name}`, b.make(), clone(result));
writeFileSync(
  new URL("examples/memo-broken/manifest.json", root),
  JSON.stringify(
    {
      about:
        "Broken copies of examples/memo-01, where each bidder wrote their refund address in their own bid memo. Each copy passes every other check and fails refund-receivers.",
      copies: broken.map(({ name, changed, story }) => ({ name, changed, expectedFailingCheck: "refund-receivers", story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/memo-01 and examples/memo-broken (2 copies)");
