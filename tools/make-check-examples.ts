// Builds examples/checks-broken: broken copies for the checks that no other broken folder trips.
// Run: node tools/make-check-examples.ts   (after `npm run examples` has made examples/guards)
// Every copy starts from an honest round and changes one thing. Nothing here uses a key.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

const disclosure: Disclosure = read("examples/round-01/disclosure.json");
const result: SellerResult = read("examples/round-01/result.json");

rmSync(new URL("examples/checks-broken/", root), { recursive: true, force: true });
const dir = (name: string) => {
  const u = new URL(`examples/checks-broken/${name}/`, root);
  mkdirSync(u, { recursive: true });
  return u;
};
const write = (name: string, d: Disclosure, r: SellerResult) => {
  const u = dir(name);
  writeFileSync(new URL("disclosure.json", u), json(d));
  writeFileSync(new URL("result.json", u), json(r));
};

interface Copy {
  name: string;
  changed: string;
  expectedFailingChecks: string[];
  story: string;
  chain?: boolean;
}
const copies: Copy[] = [];
const add = (c: Copy) => copies.push(c);

{
  const d = clone(disclosure);
  d.transactions[0].height = 0;
  write("01-block-height-is-zero", d, clone(result));
  add({
    name: "01-block-height-is-zero",
    changed: "disclosure.json",
    expectedFailingChecks: ["close-height"],
    story: "One disclosed transaction is listed at block height 0, which is not a real block, so its timing cannot be checked.",
  });
}
{
  const d = clone(disclosure);
  d.transactions.push(clone(d.transactions[0]));
  write("02-same-transaction-listed-twice", d, clone(result));
  add({
    name: "02-same-transaction-listed-twice",
    changed: "disclosure.json",
    expectedFailingChecks: ["disclosure-txids-unique", "bid-amounts", "no-duplicate-bids", "refunds-paid", "refund-total"],
    story: "The seller lists the same bid transaction twice, so one payment is counted two times.",
  });
}
{
  const d = clone(disclosure);
  const [a, b] = d.transactions;
  [a.txHex, b.txHex] = [b.txHex, a.txHex];
  write("03-transaction-bytes-swapped", d, clone(result));
  add({
    name: "03-transaction-bytes-swapped",
    changed: "disclosure.json",
    expectedFailingChecks: ["txids-match-bytes"],
    story: "The seller swaps the raw bytes of two transactions, so the ids they publish no longer belong to the transactions behind them.",
  });
}
{
  const r = clone(result);
  r.winners = [...r.winners, r.bids[2].txid];
  write("04-more-winners-than-items", clone(disclosure), r);
  add({
    name: "04-more-winners-than-items",
    changed: "result.json",
    expectedFailingChecks: ["winner-count", "winners-and-price", "refund-total"],
    story: "The lot has 2 items but the seller names 3 winners.",
  });
}
{
  // The two files of examples/guards/other-lot-bid: the lot's address also received a payment that is not a bid.
  const u = dir("05-key-shows-a-payment-that-is-not-a-bid");
  for (const f of ["disclosure.json", "result.json"]) copyFileSync(new URL(`examples/guards/other-lot-bid/${f}`, root), new URL(f, u));
  add({
    name: "05-key-shows-a-payment-that-is-not-a-bid",
    changed: "disclosure.json",
    expectedFailingChecks: ["key-hygiene"],
    story: "The lot's viewing key also shows a payment that is not a bid for this lot, so publishing the key would expose it. The seller should have used a fresh key for the lot.",
  });
}
{
  const chain = read("examples/scan-01/chain.json");
  chain.blocks = chain.blocks.filter((b: { height: number }) => b.height !== 4200070);
  const u = dir("06-one-block-missing-from-the-scan");
  copyFileSync(new URL("examples/scan-01/disclosure.json", root), new URL("disclosure.json", u));
  copyFileSync(new URL("examples/scan-01/result.json", root), new URL("result.json", u));
  writeFileSync(new URL("chain.json", u), JSON.stringify(chain));
  add({
    name: "06-one-block-missing-from-the-scan",
    changed: "chain.json",
    expectedFailingChecks: ["scan-blocks-read"],
    story: "The block file leaves out block 4200070, so a hidden bid could sit in the one block nobody read. The scan refuses to pass.",
    chain: true,
  });
}

writeFileSync(
  new URL("examples/checks-broken/manifest.json", root),
  json({
    about: "Broken copies that cover the checks no other broken folder trips: a bad block height, a transaction listed twice, swapped transaction bytes, too many winners, a viewing key that shows more than the lot, and a missing block in the scan. Each copy changes one thing and fails on the checks listed. Copy 06 is checked with `--scan --chain` using its own chain.json.",
    copies: copies.map(({ name, changed, expectedFailingChecks, story, chain }) => ({ name, changed, expectedFailingCheck: expectedFailingChecks[0], expectedFailingChecks, ...(chain ? { chain: "chain.json" } : {}), story })),
  }),
);
console.log(`wrote examples/checks-broken (${copies.length} copies)`);
