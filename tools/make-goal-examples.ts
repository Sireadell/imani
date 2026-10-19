// Builds examples/goal-reached, examples/goal-missed and examples/goal-broken from the same made-up
// chain as round-01 (test/vectors/auction-round.json). Run: node tools/make-goal-examples.ts
// Goal rule: if the on-time payments add up to the goal, every one is kept; if not, every one is
// refunded in full. Late payments are always refunded in full.
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
const base = { format: "imani-lot-disclosure/1" as const, lotId: v.lotId as string, network: v.network as "test", closeHeight: v.closeHeight as number, ufvk: v.parties["lot LOT-01"].ufvk as string };

// Reached: Alice 3,000,000 + Bob 2,000,000 + Carol 1,500,000 = 6,500,000 against a goal of 6,000,000.
// Dave's 1,200,000 came after the close and goes back.
const reachedD: Disclosure = { ...base, rules: { kind: "goal", goalZat: 6_000_000 }, transactions: ["bid_alice", "bid_bob", "bid_carol", "bid_dave_late", "refund_dave_late"].map(tx) };
const reachedR: SellerResult = {
  format: "imani-lot-result/1",
  lotId: v.lotId,
  rules: { kind: "goal", goalZat: 6_000_000 },
  bidCount: 3,
  bids: [
    { txid: id("bid_alice"), amountZat: 3_000_000 },
    { txid: id("bid_bob"), amountZat: 2_000_000 },
    { txid: id("bid_carol"), amountZat: 1_500_000 },
  ],
  winners: [id("bid_alice"), id("bid_bob"), id("bid_carol")],
  clearingPriceZat: 0,
  reserveMet: true,
  refunds: [{ bidTxid: id("bid_dave_late"), amountZat: 1_200_000, reason: "late", memo: memo("bid_dave_late") }],
};

// Missed: only Carol's 1,500,000 came in on time, against a goal of 2,000,000. She gets it all back.
const missedD: Disclosure = { ...base, rules: { kind: "goal", goalZat: 2_000_000 }, transactions: ["bid_carol", "bid_dave_late", "refund_carol", "refund_dave_late"].map(tx) };
const missedR: SellerResult = {
  format: "imani-lot-result/1",
  lotId: v.lotId,
  rules: { kind: "goal", goalZat: 2_000_000 },
  bidCount: 1,
  bids: [{ txid: id("bid_carol"), amountZat: 1_500_000 }],
  winners: [],
  clearingPriceZat: 0,
  reserveMet: false,
  refunds: [
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
for (const dir of ["goal-reached", "goal-missed", "goal-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("goal-reached", reachedD, reachedR);
write("goal-missed", missedD, missedR);

const broken: { name: string; story: string; expectedFailingChecks: string[]; changed: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-refund-to-a-contributor",
    story: "The goal was reached, so every payment is kept. The seller still lists a 500,000 refund for Alice that never happened.",
    expectedFailingChecks: ["refund-total", "result-consistent"],
    changed: "result.json",
    make: () => {
      const r = clone(reachedR);
      r.refunds.push({ bidTxid: id("bid_alice"), amountZat: 500_000, reason: "change", memo: memo("bid_alice") });
      return [clone(reachedD), r];
    },
  },
  {
    name: "02-says-goal-missed-when-reached",
    story: "The 6,500,000 collected beats the 6,000,000 goal. The seller says the goal was missed and lists everyone as refunded.",
    expectedFailingChecks: ["goal-reached", "reserve", "winners-and-price"],
    changed: "result.json",
    make: () => {
      const r = clone(reachedR);
      r.winners = [];
      r.reserveMet = false;
      r.refunds = [
        { bidTxid: id("bid_alice"), amountZat: 3_000_000, reason: "loser", memo: memo("bid_alice") },
        { bidTxid: id("bid_bob"), amountZat: 2_000_000, reason: "loser", memo: memo("bid_bob") },
        { bidTxid: id("bid_carol"), amountZat: 1_500_000, reason: "loser", memo: memo("bid_carol") },
        ...r.refunds,
      ];
      return [clone(reachedD), r];
    },
  },
  {
    name: "03-goal-raised-after-the-fact",
    story: "The disclosure now shows a goal of 7,000,000, higher than the 6,000,000 the result was built on, so the goal looks missed while the seller keeps the money.",
    expectedFailingChecks: ["goal-reached", "refunds-paid", "reserve", "result-consistent", "winners-and-price"],
    changed: "disclosure.json",
    make: () => {
      const d = clone(reachedD);
      d.rules = { kind: "goal", goalZat: 7_000_000 };
      return [d, clone(reachedR)];
    },
  },
  {
    name: "04-says-goal-reached-when-missed",
    story: "Only 1,500,000 came in against a goal of 2,000,000. The seller says the goal was reached and keeps Carol's money, though her refund went out on the chain.",
    expectedFailingChecks: ["goal-reached", "reserve", "winners-and-price"],
    changed: "result.json",
    make: () => {
      const r = clone(missedR);
      r.winners = [id("bid_carol")];
      r.reserveMet = true;
      r.refunds = r.refunds.filter((f) => f.reason === "late");
      return [clone(missedD), r];
    },
  },
];
for (const b of broken) {
  const [d, r] = b.make();
  write(`goal-broken/${b.name}`, d, r);
}
writeFileSync(
  new URL("examples/goal-broken/manifest.json", root),
  JSON.stringify(
    {
      about: "Broken copies of the goal rounds (examples/goal-reached for 01 to 03, examples/goal-missed for 04). Each copy is a different cheat and fails on the checks listed.",
      copies: broken.map(({ name, changed, expectedFailingChecks, story }) => ({ name, changed, expectedFailingCheck: expectedFailingChecks[0], expectedFailingChecks, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/goal-reached, examples/goal-missed and examples/goal-broken (4 copies)");
