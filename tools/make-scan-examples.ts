// Builds examples/scan-01 and examples/scan-broken from examples/round-01 and the offline
// test transactions in test/vectors (made by tools/gen-vectors). No new transaction is made:
// every block holds transactions that already exist in the vector files.
// Run: node tools/make-scan-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";
import type { ChainBlock, ChainFile } from "../src/scan/chain.ts";

const root = new URL("../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const v = json("test/vectors/auction-round.json");
const offline = json("test/vectors/offline-vectors.json");
const round: Disclosure = json("examples/round-01/disclosure.json");
const roundResult: SellerResult = json("examples/round-01/result.json");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const id = (label: string) => v.transactions[label].txid as string;
const tx = (label: string) => ({ txid: id(label), txHex: v.transactions[label].txHex as string });

// The lot's range: bids count from block 4200005 to the close at 4200100; refunds are paid by 4200125.
const OPEN = 4_200_005;
const REFUND_BY = 4_200_125;
// The chain file covers a little more than the range on both sides, so the scan has to pick the range itself.
const FIRST = 4_200_000;
const LAST = 4_200_140;

const disclosure: Disclosure = { ...clone(round), openHeight: OPEN, refundByHeight: REFUND_BY };
// Keep the field order readable: put the new heights next to closeHeight.
const ordered = (d: Disclosure): Disclosure => {
  const { format, lotId, network, openHeight, closeHeight, refundByHeight, rules, ufvk, transactions } = d;
  return { format, lotId, network, openHeight, closeHeight, refundByHeight, rules, ufvk, transactions } as Disclosure;
};

/** Every block from FIRST to LAST. `placed` puts transactions at heights; other blocks are empty. */
function chain(placed: [number, string][], about: string): ChainFile {
  const blocks: ChainBlock[] = [];
  for (let h = FIRST; h <= LAST; h++) blocks.push({ height: h, txs: [] });
  for (const [h, label] of placed) {
    const t = label.startsWith("filler:") ? fillerTx(label.slice(7)) : tx(label);
    blocks[h - FIRST].txs.push(t);
  }
  return { format: "imani-chain/1", network: "test", about, blocks };
}
function fillerTx(name: string) {
  const c = offline.cases[name];
  return { txid: c.txid as string, txHex: c.txHex as string };
}

// The honest chain: the round-01 transactions at their own heights, plus two payments
// between other people that the lot key cannot read (filler, to show they are skipped).
const honestPlaced: [number, string][] = [
  [4_200_007, "filler:ironwood_v6_payment"],
  [4_200_010, "bid_alice"],
  [4_200_020, "bid_bob"],
  [4_200_030, "bid_carol"],
  [4_200_050, "filler:ironwood_v6_refund"],
  [4_200_105, "bid_dave_late"],
  [4_200_120, "refund_alice_change"],
  [4_200_121, "refund_bob_change"],
  [4_200_122, "refund_carol"],
  [4_200_123, "refund_dave_late"],
];
for (const [h, label] of honestPlaced) {
  if (!label.startsWith("filler:") && v.transactions[label].height !== h) throw new Error(`${label} is not at its vector height`);
}
const ABOUT =
  "Offline test chain for examples. Blocks 4200000 to 4200140 of a made-up test network stretch. Transactions come from test/vectors (built offline with throwaway keys, never broadcast). Empty blocks stand for blocks with nothing in them for anyone.";

const write = (dir: string, files: Record<string, unknown>) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(new URL(name, u), JSON.stringify(content, null, 2) + "\n");
};

for (const dir of ["scan-01", "scan-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });

write("scan-01", {
  "disclosure.json": ordered(disclosure),
  "result.json": clone(roundResult),
  "chain.json": chain(honestPlaced, ABOUT),
  // Each bidder's own viewing key, as that bidder would give it to prove their refund arrived.
  // Throwaway test keys from test/vectors/auction-round.json.
  "bidder-keys.json": {
    format: "imani-bidder-keys/1",
    keys: [
      { bidTxid: id("bid_alice"), ufvk: v.parties["bidder alice"].ufvk },
      { bidTxid: id("bid_bob"), ufvk: v.parties["bidder bob"].ufvk },
      { bidTxid: id("bid_carol"), ufvk: v.parties["bidder carol"].ufvk },
      { bidTxid: id("bid_dave_late"), ufvk: v.parties["bidder dave"].ufvk },
    ],
  },
});

const broken: { name: string; story: string; expectedFailingCheck: string; changed: string; make: () => Record<string, unknown> }[] = [
  {
    name: "01-hidden-bid",
    story:
      "A bid of 3,000,000 was paid into the lot at block 4200060, before the close, which beats both winners. The seller left it out of the disclosure and the result and kept the money. The key level passes because it only reads what the seller lists; the scan finds the payment. (The offline test round has no spare bid with a new memo, so this payment reuses Alice's memo. The scan flags any unlisted bid payment, whatever its memo.)",
    expectedFailingCheck: "scan-hidden-bids",
    changed: "chain.json",
    make: () => ({
      "disclosure.json": ordered(disclosure),
      "result.json": clone(roundResult),
      "chain.json": chain([...honestPlaced, [4_200_060, "bid_alice_replay"]], ABOUT),
    }),
  },
  {
    name: "02-listed-not-in-range",
    story:
      "Carol's refund was paid at block 4200140, after the refund deadline at 4200125. The seller lists it at block 4200122. The scan does not find it in the lot's range.",
    expectedFailingCheck: "scan-listed-in-range",
    changed: "chain.json",
    make: () => ({
      "disclosure.json": ordered(disclosure),
      "result.json": clone(roundResult),
      "chain.json": chain(
        honestPlaced.map(([h, l]) => (l === "refund_carol" ? [4_200_140, l] : [h, l]) as [number, string]),
        ABOUT,
      ),
    }),
  },
  {
    name: "03-wrong-height",
    story:
      "Dave's bid arrived at block 4200105, five blocks after the close. The seller writes block 4200099 in the disclosure and counts Dave as an on-time losing bid. The key level is fooled, because it takes heights from the disclosure; the scan sees the bid in block 4200105.",
    expectedFailingCheck: "scan-heights",
    changed: "disclosure.json and result.json",
    make: () => {
      const d = ordered(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("bid_dave_late") ? { ...t, height: 4_200_099 } : t));
      const r = clone(roundResult);
      r.bids.push({ txid: id("bid_dave_late"), amountZat: 1_200_000 });
      r.bidCount = 4;
      for (const f of r.refunds) if (f.bidTxid === id("bid_dave_late")) f.reason = "loser";
      return { "disclosure.json": d, "result.json": r, "chain.json": chain(honestPlaced, ABOUT) };
    },
  },
];

for (const b of broken) write(`scan-broken/${b.name}`, b.make());
write("scan-broken", {
  "manifest.json": {
    about:
      "Broken copies of examples/scan-01. Each one passes the basic and key levels and fails exactly one scan-level check. Run with --scan --chain <folder>/chain.json.",
    copies: broken.map(({ name, story, expectedFailingCheck, changed }) => ({ name, changed, expectedFailingCheck, story })),
  },
});

console.log("wrote examples/scan-01 and examples/scan-broken (3 copies)");
