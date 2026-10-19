// Builds examples/sealed-01 and examples/sealed-broken from test/vectors/sealed-round.json
// (made by tools/gen-vectors in sealed mode). A sealed lot: 2 items, reserve 1,000,000, deposit
// 5,000,000, penalty 500,000. Five on-time seals (three opened honestly, one never opened, one opened
// with a price that does not match its seal), one seal with the wrong deposit and one late seal.
// Run: node tools/make-sealed-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const v = JSON.parse(readFileSync(new URL("test/vectors/sealed-round.json", root), "utf8"));
const tx = (label: string) => {
  const t = v.transactions[label];
  return { txid: t.txid as string, height: t.height as number, txHex: t.txHex as string };
};
const id = (label: string) => v.transactions[label].txid as string;
const refundMemo = (seal: string) => `refund:${v.lotId}:${id(seal)}`;
const plan = (seal: string) => v.refundPlan[seal] as number;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const LABELS = [
  "seal_alice", "seal_bob", "seal_carol", "seal_dave_unopened", "seal_erin_badhash", "seal_frank_wrong_deposit", "seal_gina_late",
  "open_alice", "open_bob", "open_carol", "open_erin_badhash",
  "refund_alice", "refund_bob", "refund_carol", "refund_dave_unopened", "refund_erin_badhash", "refund_frank_wrong_deposit", "refund_gina_late",
];
const disclosure: Disclosure = {
  format: "imani-lot-disclosure/1",
  lotId: v.lotId,
  network: v.network,
  closeHeight: v.closeHeight,
  openByHeight: v.openByHeight,
  rules: v.rules,
  ufvk: v.parties["lot LOT-01"].ufvk,
  transactions: LABELS.map(tx),
};
const refund = (seal: string, reason: SellerResult["refunds"][number]["reason"]) => ({ bidTxid: id(seal), amountZat: plan(seal), reason, memo: refundMemo(seal) });
const result: SellerResult = {
  format: "imani-lot-result/1",
  lotId: v.lotId,
  rules: v.rules,
  bidCount: 3,
  bids: [
    { txid: id("seal_alice"), amountZat: 3_000_000 },
    { txid: id("seal_bob"), amountZat: 2_000_000 },
    { txid: id("seal_carol"), amountZat: 1_500_000 },
  ],
  winners: [id("seal_alice"), id("seal_bob")],
  clearingPriceZat: 1_500_000,
  reserveMet: true,
  refunds: [
    refund("seal_alice", "change"),
    refund("seal_bob", "change"),
    refund("seal_carol", "loser"),
    refund("seal_dave_unopened", "unopened"),
    refund("seal_erin_badhash", "bad-opening"),
    refund("seal_frank_wrong_deposit", "late"),
    refund("seal_gina_late", "late"),
  ],
  unopened: [id("seal_dave_unopened"), id("seal_erin_badhash")],
};

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};

for (const dir of ["sealed-01", "sealed-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("sealed-01", disclosure, clone(result));

const broken: { name: string; story: string; changed: string; expected: string[]; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-counts-unopened-seal",
    story: "Dave paid a deposit but never opened his seal. The seller counts it as a bid of 1,200,000 anyway.",
    expected: ["seal-openings"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("seal_dave_unopened"), amountZat: 1_200_000 });
      r.bidCount = 4;
      return [clone(disclosure), r];
    },
  },
  {
    name: "02-counts-wrong-opening",
    story: "Erin sealed 900,000 and then opened 800,000, which does not match her seal. The seller counts her at 800,000.",
    expected: ["seal-openings"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("seal_erin_badhash"), amountZat: 800_000 });
      r.bidCount = 4;
      return [clone(disclosure), r];
    },
  },
  {
    name: "03-hides-unopened-seal",
    story: "Erin's seal was opened wrongly, so she paid the penalty. The seller leaves her out of the list of seals that paid it.",
    expected: ["seal-forfeits"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.unopened = [id("seal_dave_unopened")];
      return [clone(disclosure), r];
    },
  },
  {
    name: "04-keeps-the-penalty",
    story: "The seller pays Alice her refund without her share of the two penalties, and keeps it.",
    expected: ["refunds-paid", "refund-total"],
    changed: "disclosure.json (Alice's refund transaction) and result.json",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("refund_alice") ? tx("refund_alice_noshare") : t));
      const r = clone(result);
      r.refunds[0].amountZat = v.transactions.refund_alice_noshare.outputs[0].amountZat;
      return [d, r];
    },
  },
  {
    name: "05-counts-wrong-deposit",
    story: "Frank paid a deposit of 4,999,999 instead of 5,000,000. The seller counts his seal as a bid of 1,000,000.",
    expected: ["seal-deposits"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("seal_frank_wrong_deposit"), amountZat: 1_000_000 });
      r.bidCount = 4;
      return [clone(disclosure), r];
    },
  },
  {
    name: "06-counts-late-seal",
    story: "Gina's seal arrived 5 blocks after the close. The seller counts it as a bid of 1,100,000.",
    expected: ["no-late-bids", "seal-deposits"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("seal_gina_late"), amountZat: 1_100_000 });
      r.bidCount = 4;
      return [clone(disclosure), r];
    },
  },
  {
    name: "07-wrong-opened-price",
    story: "The seller reports Alice's opened price as 2,900,000. She opened 3,000,000.",
    expected: ["bid-amounts"],
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids[0].amountZat = 2_900_000;
      return [clone(disclosure), r];
    },
  },
  {
    name: "08-missing-refund",
    story: "Carol lost and her refund was never sent. The seller's file still lists it.",
    expected: ["refunds-paid"],
    changed: "disclosure.json",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.filter((t) => t.txid !== id("refund_carol"));
      return [d, clone(result)];
    },
  },
];
for (const b of broken) {
  const [d, r] = b.make();
  write(`sealed-broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/sealed-broken/manifest.json", root),
  JSON.stringify(
    {
      about:
        "Broken copies of examples/sealed-01, a sealed lot. Each changes one thing the seller says or sends and fails the named checks.",
      copies: broken.map(({ name, changed, story, expected }) => ({ name, changed, expectedFailingChecks: expected, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote examples/sealed-01 and examples/sealed-broken (${broken.length} copies)`);
