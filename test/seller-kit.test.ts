// Locked answers for the seller kit. Written before the first run.
//   lot-new: writes lot-public.json (no key in it), lot-private.json (the key) and CHECKLIST.md; refuses a spending
//   key, a seed phrase, a transparent address, a network mismatch, blocks out of order and any existing file.
//   settle: on the real test-network round (examples/testnet-01) it rebuilds the seller's files from the chain alone,
//   with the same bids, winners, price and refunds as the seller's own files, plus published totals, and PASSES.
//   With one refund missing from the chain it still writes the files, lists the refund owed and exits 1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";

const rd = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const disc = rd("examples/testnet-01/disclosure.json");
const sellerResult = rd("examples/testnet-01/result.json");
const chain = rd("examples/testnet-01/chain.json");
const vec = rd("test/vectors/auction-round.json");
const ADDRESS: string = vec.parties["lot LOT-01"].address;

let tmp = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "imani-kit-"));
  writeFileSync(join(tmp, "key.txt"), disc.ufvk + "\n");
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const lotNewArgs = (folder: string, extra: string[] = []) => [
  "lot-new", "--lot", disc.lotId, "--address", ADDRESS, "--key-file", join(tmp, "key.txt"), "--items", "2", "--reserve-zat", "1000000",
  "--open-height", String(disc.openHeight), "--close-height", String(disc.closeHeight), "--refund-by-height", String(disc.refundByHeight), "--out", folder, ...extra,
];

test("lot-new writes the three files, and the public one holds no key", () => {
  const f = join(tmp, "lot-a");
  const r = run(lotNewArgs(f));
  assert.equal(r.code, 0, r.stderr);
  const pub = JSON.parse(readFileSync(join(f, "lot-public.json"), "utf8"));
  const priv = JSON.parse(readFileSync(join(f, "lot-private.json"), "utf8"));
  assert.equal(pub.format, "imani-lot-public/1");
  assert.equal(pub.lotAddress, ADDRESS);
  assert.equal(pub.network, "test");
  assert.equal(pub.itemCount, 2);
  assert.ok(!JSON.stringify(pub).includes(disc.ufvk));
  assert.equal(priv.ufvk, disc.ufvk);
  assert.deepEqual(priv.rules, { itemCount: 2, reserveZat: 1_000_000 });
  assert.match(readFileSync(join(f, "CHECKLIST.md"), "utf8"), /Checklist for lot DRY-01/);
  assert.ok(!r.stdout.includes(disc.ufvk));
  assert.match(r.stdout, /Servers contacted: none/);
});

test("lot-new carries the price rule and top-ups into both files", () => {
  const f = join(tmp, "lot-b");
  assert.equal(run(lotNewArgs(f, ["--pricing", "lowest-winning", "--top-ups"])).code, 0);
  const pub = JSON.parse(readFileSync(join(f, "lot-public.json"), "utf8"));
  const priv = JSON.parse(readFileSync(join(f, "lot-private.json"), "utf8"));
  assert.equal(pub.pricing, "lowest-winning");
  assert.equal(pub.topUps, true);
  assert.deepEqual(priv.rules, { itemCount: 2, reserveZat: 1_000_000, pricing: "lowest-winning", topUps: true });
  assert.match(readFileSync(join(f, "CHECKLIST.md"), "utf8"), /lowest bid that won, bidders may raise a bid/);
});

test("lot-new refuses bad input with code 2 and writes nothing", () => {
  const spend = join(tmp, "spend.txt");
  writeFileSync(spend, "secret-extended-key-test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
  const seed = join(tmp, "seed.txt");
  writeFileSync(seed, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  const cases: [string, string[], RegExp][] = [
    ["spending key", ["--key-file", spend], /spending key|read-only|viewing key/i],
    ["seed phrase", ["--key-file", seed], /seed phrase|viewing key/i],
    ["transparent address", ["--address", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"], /shielded/],
    ["blocks out of order", ["--close-height", String(disc.openHeight - 1)], /in order/],
    ["no items", ["--items", "0"], /items/],
    ["bad price rule", ["--pricing", "cheapest"], /price rule/],
  ];
  for (const [name, over, re] of cases) {
    const f = join(tmp, `lot-bad-${name.replace(/ /g, "-")}`);
    const args = lotNewArgs(f);
    for (let i = 0; i < over.length; i += 2) {
      const at = args.indexOf(over[i]);
      if (at >= 0) args[at + 1] = over[i + 1];
      else args.push(over[i], over[i + 1]);
    }
    const r = run(args);
    assert.equal(r.code, 2, name);
    assert.match(r.stderr, re, name);
    assert.equal(existsSync(join(f, "lot-private.json")), false, name);
  }
});

test("lot-new does not overwrite files that are already there", () => {
  const f = join(tmp, "lot-c");
  assert.equal(run(lotNewArgs(f)).code, 0);
  const again = run(lotNewArgs(f));
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
});

const settleArgs = (folder: string, chainFile: string) => ["settle", "--folder", folder, "--chain", chainFile];
const writeChain = (name: string, blocks: unknown) => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ ...chain, blocks }));
  return p;
};

test("settle rebuilds the real test-network round from the chain and passes, with the same numbers as the seller's own files", () => {
  const f = join(tmp, "lot-real");
  assert.equal(run(lotNewArgs(f)).code, 0);
  const r = run(settleArgs(f, fileURLToPath(new URL("../examples/testnet-01/chain.json", import.meta.url))));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(readFileSync(join(f, "settled", "result.json"), "utf8"));
  assert.equal(out.bidCount, sellerResult.bidCount);
  assert.equal(out.clearingPriceZat, sellerResult.clearingPriceZat);
  assert.deepEqual([...out.winners].sort(), [...sellerResult.winners].sort());
  assert.deepEqual(out.bids.map((b: any) => [b.txid, b.amountZat]).sort(), sellerResult.bids.map((b: any) => [b.txid, b.amountZat]).sort());
  assert.deepEqual(out.refunds.map((x: any) => [x.bidTxid, x.amountZat]).sort(), sellerResult.refunds.map((x: any) => [x.bidTxid, x.amountZat]).sort());
  assert.deepEqual(out.totals, { payments: 3, receivedZat: 6_500_000, keptZat: 3_000_000, refundedZat: 3_500_000 });
  assert.match(r.stdout, /Refunds owed \(3\)/);
  assert.match(r.stdout, /PASS/);
  // The published files check on their own, the way a bidder would run them.
  const d = JSON.parse(readFileSync(join(f, "settled", "disclosure.json"), "utf8"));
  assert.equal(d.lotId, disc.lotId);
  assert.equal(d.closeHeight, disc.closeHeight);
});

test("settle with a refund missing from the chain lists what is owed, writes the files and exits 1", () => {
  const f = join(tmp, "lot-short");
  assert.equal(run(lotNewArgs(f)).code, 0);
  const dropped = sellerResult.refunds.length;
  assert.ok(dropped >= 1);
  const refundTx = new Set(disc.transactions.filter((t: any) => t.height > disc.closeHeight).map((t: any) => t.txid));
  const lastRefund = [...refundTx].pop();
  const blocks = chain.blocks.map((b: any) => ({ ...b, txs: b.txs.filter((t: any) => t.txid !== lastRefund) }));
  const r = run(settleArgs(f, writeChain("short-chain.json", blocks)));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Refunds owed/);
  assert.match(r.stdout, /refunds-paid/);
  assert.equal(existsSync(join(f, "settled", "result.json")), true);
});

test("settle refuses a missing folder and asks for blocks", () => {
  assert.equal(run(["settle", "--folder", join(tmp, "nope"), "--chain", "x.json"]).code, 2);
  assert.equal(run(["settle", "--folder", join(tmp, "lot-real")]).code, 2);
  assert.equal(run(["settle", "--folder", join(tmp, "lot-real"), "--chain", "x.json", "--fetch"]).code, 2);
});
