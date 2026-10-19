// Builds examples/testnet-broken from examples/testnet-01, the real round on the Zcash test
// network (lot DRY-01). testnet-01 itself is not made here: its transactions were paid by a
// real wallet and its chain.json holds the real blocks, so they cannot be rebuilt offline.
// A cheating seller can only change their own two files, never the chain, so each copy below
// edits the disclosure or the result and keeps the real chain.json.
// Run: node tools/make-testnet-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const disclosure: Disclosure = json("examples/testnet-01/disclosure.json");
const result: SellerResult = json("examples/testnet-01/result.json");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// The losing bid (1,500,000) and the refund that paid it back.
const LOSER = "2f5e8f4f37650d415dc42867eeda74c70eb06924c117769de048fc5c158d7505";
const LOSER_REFUND = "cca33721ebe9a965850029aabb79301a9b7db33d02f6b82ec9f539b474189fb3";

function hiddenLosingBid(): [Disclosure, SellerResult] {
  const d = clone(disclosure);
  d.transactions = d.transactions.filter((t) => t.txid !== LOSER && t.txid !== LOSER_REFUND);
  const r = clone(result);
  r.bids = r.bids.filter((b) => b.txid !== LOSER);
  r.bidCount = r.bids.length;
  r.refunds = r.refunds.filter((x) => x.bidTxid !== LOSER);
  // With the third bid gone, the seller says the price falls to the reserve.
  r.clearingPriceZat = r.rules.reserveZat;
  return [d, r];
}

function shortRefundClaim(): [Disclosure, SellerResult] {
  const r = clone(result);
  const refund = r.refunds.find((x) => x.bidTxid === LOSER)!;
  refund.amountZat = 1_400_000;
  return [clone(disclosure), r];
}

const copies = [
  {
    name: "01-hidden-losing-bid",
    changed: "disclosure.json and result.json",
    expectedFailingCheck: "scan-hidden-bids",
    expectedFailingChecks: ["refunds-paid", "refund-total", "scan-hidden-bids", "scan-unlisted-payments"],
    story:
      "The seller leaves the losing bid of 1,500,000 and its refund out of their files, then says that with only two bids the price falls to the reserve of 1,000,000. The refunds on the chain no longer add up, and the scan of the real blocks finds the bid and the refund the seller left out.",
    make: hiddenLosingBid,
  },
  {
    name: "02-short-refund-claim",
    changed: "result.json",
    expectedFailingCheck: "refund-total",
    expectedFailingChecks: ["result-consistent", "refund-total"],
    story:
      "The seller's result says the losing bidder got 1,400,000 back. The chain shows the real refund was 1,500,000, so the seller's sums are 100,000 out and the result contradicts itself.",
    make: shortRefundClaim,
  },
];

const out = new URL("examples/testnet-broken/", root);
rmSync(out, { recursive: true, force: true });
for (const c of copies) {
  const dir = new URL(`${c.name}/`, out);
  mkdirSync(dir, { recursive: true });
  const [d, r] = c.make();
  if (c.changed.includes("disclosure")) writeFileSync(new URL("disclosure.json", dir), JSON.stringify(d, null, 1) + "\n");
  writeFileSync(new URL("result.json", dir), JSON.stringify(r, null, 1) + "\n");
}
writeFileSync(
  new URL("manifest.json", out),
  JSON.stringify(
    {
      about:
        "Copies of examples/testnet-01, the real round on the Zcash test network, where the seller changed their own files. The chain cannot be changed, so every copy is checked against the real chain.json. Run with --scan --chain examples/testnet-01/chain.json. A real cheat fails several checks at once; expectedFailingChecks lists them all.",
      copies: copies.map(({ make: _m, ...c }) => c),
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${copies.length} copies to examples/testnet-broken`);
