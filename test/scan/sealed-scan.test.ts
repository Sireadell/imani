// Scan level on a sealed lot. Answers written first: the honest sealed round passes all three
// levels; a seller who leaves one opening out of the disclosure fails scan-hidden-bids, and the
// message names the opening and calls it an opening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot } from "../../src/check.ts";
import { blocksInRange, type ChainBlock, type ChainFile } from "../../src/scan/chain.ts";
import { scanRange, type ScanInput } from "../../src/scan/scan.ts";

const json = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
const vec = json("test/vectors/sealed-round.json");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const FIRST = 4_200_000;
const LAST = 4_200_330;
const honest = { d: json("examples/sealed-01/disclosure.json"), r: json("examples/sealed-01/result.json") };
honest.d.openHeight = 4_200_005;
honest.d.refundByHeight = 4_200_300;

/** Every block from FIRST to LAST with the round's transactions at their own heights. */
function chainOf(): ChainFile {
  const blocks: ChainBlock[] = [];
  for (let h = FIRST; h <= LAST; h++) blocks.push({ height: h, txs: [] });
  for (const t of honest.d.transactions) blocks[t.height - FIRST].txs.push({ txid: t.txid, txHex: t.txHex });
  return { format: "imani-chain/1", network: "test", blocks };
}
function scanOf(d: any): ScanInput {
  const range = scanRange(d, 10);
  const { blocks, missing } = blocksInRange(chainOf(), range.from, range.to);
  return { blocks, missing, graceBlocks: 10, source: { kind: "chain-file", label: "test chain", serversContacted: [], bytes: 0, ms: 0 } };
}

test("the honest sealed round passes all three levels", () => {
  const v = checkLot(clone(honest.d), clone(honest.r), { scan: scanOf(honest.d) });
  assert.equal(v.result, "PASS", v.failed.join(", "));
  assert.equal(v.scanLevel, "PASS");
  assert.equal(v.checks.find((c) => c.id === "scan-hidden-bids")!.status, "PASS");
});

test("a seller who leaves one opening out of the disclosure fails scan-hidden-bids and the message names it", () => {
  const opening = vec.transactions.open_carol.txid as string;
  const d = clone(honest.d);
  d.transactions = d.transactions.filter((t: any) => t.txid !== opening);
  const v = checkLot(d, clone(honest.r), { scan: scanOf(honest.d) });
  assert.ok(v.failed.includes("scan-hidden-bids"));
  const msg = v.checks.find((c) => c.id === "scan-hidden-bids")!.reason;
  assert.ok(msg.includes(`hidden opening: ${opening.slice(0, 10)}`), msg);
});

test("a seller who leaves one seal out of the disclosure fails scan-hidden-bids and the message calls it a seal", () => {
  const seal = vec.transactions.seal_dave_unopened.txid as string;
  const d = clone(honest.d);
  d.transactions = d.transactions.filter((t: any) => t.txid !== seal);
  const v = checkLot(d, clone(honest.r), { scan: scanOf(honest.d) });
  assert.ok(v.failed.includes("scan-hidden-bids"));
  assert.ok(v.checks.find((c) => c.id === "scan-hidden-bids")!.reason.includes(`hidden seal: ${seal.slice(0, 10)}`));
});
