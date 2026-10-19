// Bidder check: a bidder confirms their bid and refund with their own key and public chain data.
// The honest round is examples/scan-01 (offline, throwaway keys). Tampered cases change only what
// a cheating seller could change on the chain: which payments exist and when.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bidderCheck, validateFacts, type BidClaim, type PublishedResult } from "../src/bidder.ts";
import { run, runAsync } from "../src/cli.ts";
import { blocksInRange, type ChainFile } from "../src/scan/chain.ts";
import { bidderRange } from "../src/bidder.ts";

const ex = (p: string) => new URL(`../examples/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(ex(p), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("./vectors/auction-round.json", import.meta.url), "utf8"));
const facts = json("bidder-01/lot-public.json");
const chain: ChainFile = json("scan-01/chain.json");
const keyOf = (party: string) => vectors.parties[party].ufvk as string;
const id = (label: string) => vectors.transactions[label].txid as string;
const seller = json("scan-01/result.json") as PublishedResult;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const source = { kind: "chain-file" as const, label: "test chain", serversContacted: [], bytes: 0, ms: 0 };

/** Move, drop or swap transactions on the chain, the way a cheating seller's side of the story would need. */
function tamper(f: (blocks: Map<number, { txid: string; txHex: string }[]>) => void): ChainFile {
  const c = clone(chain);
  const byHeight = new Map(c.blocks.map((b) => [b.height, b.txs]));
  f(byHeight);
  return c;
}
const drop = (c: ChainFile, label: string) => {
  for (const b of c.blocks) b.txs = b.txs.filter((t) => t.txid !== id(label));
};
const put = (c: ChainFile, height: number, label: string) => {
  c.blocks.find((b) => b.height === height)!.txs.push({ txid: id(label), txHex: vectors.transactions[label].txHex });
};

function check(who: string, bidLabel: string, amountZat: number | undefined, c: ChainFile = chain, published?: PublishedResult) {
  const range = bidderRange(facts, 10);
  const { blocks, missing } = blocksInRange(c, range.from, range.to);
  const bids: BidClaim[] = [{ txid: id(bidLabel), amountZat }];
  return bidderCheck({ facts, ufvk: keyOf(who), blocks, missing, source, graceBlocks: 10, bids, published });
}
const line = (r: ReturnType<typeof check>, lineId: string) => r.bids[0].lines.find((l) => l.id === lineId);

test("lot facts file is valid and a bad one is refused", () => {
  validateFacts(facts);
  assert.throws(() => validateFacts({ ...facts, format: "x" }), /imani-lot-public\/1/);
  assert.throws(() => validateFacts({ ...facts, openHeight: 0 }), /openHeight/);
  assert.throws(() => validateFacts({ ...facts, lotAddress: "nope" }), /lotAddress/);
});

test("honest: a losing bidder sees the bid landed on time and the whole bid came back", () => {
  const r = check("bidder carol", "bid_carol", 1_500_000);
  assert.equal(r.result, "PASS");
  assert.match(line(r, "landed")!.text, /block 4200030, inside the bidding window/);
  assert.match(line(r, "refund")!.text, /refunded your whole bid: 1,500,000 zat/);
});

test("honest: a winner sees the price they paid, and is told the key cannot confirm it is the clearing price", () => {
  const r = check("bidder alice", "bid_alice", 3_000_000);
  assert.equal(r.result, "PASS");
  assert.match(line(r, "refund")!.text, /you paid 1,500,000 zat, within your bid and not below the reserve 1,000,000 zat/);
  assert.match(line(r, "refund")!.text, /right clearing price your key cannot show/);
  const bob = check("bidder bob", "bid_bob", 2_000_000);
  assert.match(line(bob, "refund")!.text, /you paid 1,500,000 zat/);
});

test("honest: a late bid is shown as late and its full refund is proven", () => {
  const r = check("bidder dave", "bid_dave_late", 1_200_000);
  assert.equal(r.result, "PASS");
  assert.match(line(r, "landed")!.text, /AFTER the close at 4200100/);
  assert.match(line(r, "refund")!.text, /refunded in full: 1,200,000 zat/);
});

test("honest: the seller's published result, when given, matches", () => {
  const r = check("bidder carol", "bid_carol", 1_500_000, chain, seller);
  assert.equal(r.result, "PASS");
  assert.equal(line(r, "seller-counted")!.mark, "PROVEN");
  assert.equal(line(r, "seller-refund")!.mark, "PROVEN");
  const alice = check("bidder alice", "bid_alice", 3_000_000, chain, seller);
  assert.equal(alice.result, "PASS");
});

test("without an amount, the refund is shown but nothing is compared (NOT PROVEN)", () => {
  const r = check("bidder carol", "bid_carol", undefined);
  assert.equal(r.result, "NOT PROVEN");
  assert.match(line(r, "refund")!.text, /Refund received.*1,500,000 zat/);
});

// ---------- tampered ----------

test("tampered: the bid payment is not on the chain at all -> FAIL", () => {
  const c = clone(chain);
  drop(c, "bid_carol");
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(r.result, "FAIL");
  assert.match(line(r, "landed")!.text, /is not in any block from 4200005/);
});

test("tampered: the bid moved to after the close, so it is outside the window -> shows late and FAILs the refund rule if refunded short", () => {
  const c = clone(chain);
  drop(c, "bid_carol");
  put(c, 4_200_101, "bid_carol");
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.match(line(r, "landed")!.text, /AFTER the close/);
  // The refund in the chain is still the full 1,500,000, so a late bid fully refunded passes. Make it short:
  drop(c, "refund_carol");
  put(c, 4_200_122, "refund_carol_short");
  const short = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(short.result, "FAIL");
  assert.match(line(short, "refund")!.text, /whole 1,500,000 zat must come back, and your key received 1,400,000 zat/);
});

test("tampered: short refund (100,000 too little) -> FAIL, the implied price is below the reserve", () => {
  const c = clone(chain);
  drop(c, "refund_carol");
  put(c, 4_200_122, "refund_carol_short");
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(r.result, "FAIL");
  assert.match(line(r, "refund")!.text, /You paid 100,000 zat.*below the reserve 1,000,000 zat/);
});

test("tampered: a short refund that still looks like a win is caught by the seller's own published result", () => {
  const c = clone(chain);
  drop(c, "refund_carol");
  put(c, 4_200_122, "refund_carol_short");
  // Bidder alone: fails on the reserve. With the seller's claim of 1,500,000, it also fails the match.
  const r = check("bidder carol", "bid_carol", 1_500_000, c, seller);
  assert.equal(line(r, "seller-refund")!.mark, "FAIL");
  assert.match(line(r, "seller-refund")!.text, /seller says your refund is 1,500,000 zat but your key received 1,400,000 zat/);
  // Alice, a winner, told by the seller that her refund is 1,400,000 when the chain paid her 1,500,000.
  const claim = clone(seller);
  claim.refunds.find((f) => f.bidTxid === id("bid_alice"))!.amountZat = 1_400_000;
  const a = check("bidder alice", "bid_alice", 3_000_000, chain, claim);
  assert.equal(a.result, "FAIL");
  assert.equal(line(a, "seller-refund")!.mark, "FAIL");
});

test("tampered: refund paid after the deadline -> FAIL, named late", () => {
  const c = clone(chain);
  drop(c, "refund_carol");
  put(c, 4_200_130, "refund_carol");
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(r.result, "FAIL");
  assert.match(line(r, "late-refund")!.text, /arrived at block 4200130, after the refund deadline at 4200125/);
});

test("tampered: no refund at all -> NOT PROVEN, never PASS, and says why it cannot tell", () => {
  const c = clone(chain);
  drop(c, "refund_carol");
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(r.result, "NOT PROVEN");
  assert.match(line(r, "refund")!.text, /won at your full bid that is right.*Your key alone cannot tell which/);
  // With the seller's result, the missing refund the seller claims was paid fails.
  assert.equal(check("bidder carol", "bid_carol", 1_500_000, c, seller).result, "FAIL");
});

test("tampered: the seller's published result leaves the bid out -> FAIL", () => {
  const claim = clone(seller);
  claim.bids = claim.bids.filter((b) => b.txid !== id("bid_carol"));
  claim.refunds = claim.refunds.filter((f) => f.bidTxid !== id("bid_carol"));
  const r = check("bidder carol", "bid_carol", 1_500_000, chain, claim);
  assert.equal(r.result, "FAIL");
  assert.match(line(r, "seller-counted")!.text, /does not count it/);
});

test("tampered: refund bigger than the bid, and a block missing from the read, both FAIL", () => {
  assert.match(line(check("bidder carol", "bid_carol", 1_000_000), "refund")!.text, /more than your bid/);
  const c = clone(chain);
  c.blocks = c.blocks.filter((b) => b.height !== 4_200_050);
  const r = check("bidder carol", "bid_carol", 1_500_000, c);
  assert.equal(r.result, "FAIL");
  assert.match(r.general.join(" "), /1 blocks missing/);
});

test("another bidder's key sees nothing of this bid's refund", () => {
  const r = check("bidder bob", "bid_carol", 1_500_000);
  assert.equal(r.result, "NOT PROVEN");
  assert.match(line(r, "refund")!.text, /No refund for your bid reached your key/);
});

// ---------- command line ----------

const dir = mkdtempSync(join(tmpdir(), "imani-bidder-"));
const keyFile = (label: string) => {
  const p = join(dir, `${label.replace(/ /g, "-")}.key`);
  writeFileSync(p, keyOf(label) + "\n");
  return p;
};
const factsPath = fileURLToPath(ex("bidder-01/lot-public.json"));
const chainPath = fileURLToPath(ex("scan-01/chain.json"));
const cli = (who: string, ...rest: string[]) => run(["bidder-check", "--facts", factsPath, "--key-file", keyFile(who), "--chain", chainPath, ...rest]);

test("CLI: honest bidder passes offline and the output states the limits and no server contact", () => {
  const r = cli("bidder carol", "--bid", `${id("bid_carol")}:1500000`);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RESULT: PASS/);
  assert.match(r.stdout, /What a bidder alone can and cannot prove/);
  assert.match(r.stdout, /clearing price cannot be confirmed from your key/);
  assert.match(r.stdout, /Servers contacted: none/);
  assert.doesNotMatch(r.stdout, /uviewtest1/);
});

test("CLI: exit codes 0 pass, 1 fail, 3 not proven", () => {
  const bad = cli("bidder carol", "--bid", `${id("bid_carol")}:1000000`);
  assert.equal(bad.code, 1);
  const unknown = cli("bidder carol", "--bid", id("bid_carol"));
  assert.equal(unknown.code, 3);
  const withResult = cli("bidder carol", "--bid", `${id("bid_carol")}:1500000`, "--result", fileURLToPath(ex("scan-01/result.json")));
  assert.equal(withResult.code, 0);
  assert.match(withResult.stdout, /\[PROVEN\] The seller's result counts your bid/);
});

test("CLI: with no bid named and a key that cannot read its own payment, it asks for the transaction id", () => {
  const r = cli("bidder carol");
  assert.equal(r.code, 3);
  assert.match(r.stdout, /Give the transaction id of your bid with --bid/);
});

test("CLI: a spending key, a seed phrase, a wrong-network key and bad options are refused with exit 2", () => {
  const spend = join(dir, "spend.key");
  writeFileSync(spend, "secret-extended-key-test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
  assert.equal(run(["bidder-check", "--facts", factsPath, "--key-file", spend, "--chain", chainPath]).code, 2);
  const seed = join(dir, "seed.key");
  writeFileSync(seed, "abandon ability able about above absent absorb abstract absurd abuse access accident");
  const s = run(["bidder-check", "--facts", factsPath, "--key-file", seed, "--chain", chainPath]);
  assert.equal(s.code, 2);
  assert.match(s.stderr, /seed phrase/);
  const mainFacts = join(dir, "main.json");
  writeFileSync(mainFacts, JSON.stringify({ ...facts, network: "main" }));
  assert.equal(run(["bidder-check", "--facts", mainFacts, "--key-file", keyFile("bidder carol"), "--chain", chainPath]).code, 2);
  assert.equal(run(["bidder-check", "--facts", factsPath, "--key-file", keyFile("bidder carol")]).code, 2);
  assert.equal(run(["bidder-check", "--facts", factsPath, "--key-file", keyFile("bidder carol"), "--chain", chainPath, "--fetch"]).code, 2);
  assert.equal(run(["bidder-check", "--facts", factsPath, "--key-file", keyFile("bidder carol"), "--chain", chainPath, "--bid", "abc"]).code, 2);
});

test("CLI --fetch refuses a bad key before opening any connection", async () => {
  const seed = join(dir, "seed2.key");
  writeFileSync(seed, "abandon ability able about above absent absorb abstract absurd abuse access accident");
  const r = await runAsync(["bidder-check", "--facts", factsPath, "--key-file", seed, "--fetch"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Servers contacted: none/);
});
