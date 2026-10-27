// Bid proof: one bid proven to someone with no viewing key. Honest proofs pass on the offline
// round (LOT-01) and on the real test-network round (DRY-01). Every tampered copy must fail, and
// fail on the line that owns the fault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBidProof, validateBidProof, verifyBidProof, BidProofError, type BidProof, type MinedAt, type ProofLotFacts } from "../src/bid-proof.ts";
import { InputError } from "../src/check.ts";
import { run } from "../src/cli.ts";
import { findSecret } from "../src/guard.ts";
import type { ChainFile } from "../src/scan/chain.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// Offline round LOT-01: throwaway keys, made-up chain (examples/scan-01).
const v = json("test/vectors/auction-round.json");
const lotKey = v.parties["lot LOT-01"].ufvk as string;
const tx = (label: string) => v.transactions[label] as { txid: string; txHex: string; height: number };
const chain: ChainFile = json("examples/scan-01/chain.json");
const resultText = read("examples/scan-01/result.json");
const result = JSON.parse(resultText);
const facts: ProofLotFacts = { ...json("examples/bidder-01/lot-public.json"), lotAddress: v.parties["lot LOT-01"].address };

function mined(c: ChainFile, txid: string): MinedAt {
  for (const b of c.blocks) if (b.txs.some((t) => t.txid === txid)) return { height: b.height, found: true, source: "the test chain", serversContacted: [] };
  return { height: null, found: false, source: "the test chain", serversContacted: [] };
}
const make = (label: string, height = tx(label).height) => makeBidProof({ facts, viewingKey: lotKey, txid: tx(label).txid, txHex: tx(label).txHex, height, resultFile: resultText });
const full = (p: BidProof, r: any = result, rText: string = resultText, c: ChainFile = chain, f: ProofLotFacts = facts) =>
  verifyBidProof(p, { facts: f, result: r, resultBytes: rText, mined: mined(c, p.bid.txid) });
const alice = make("bid_alice");

/** Each tampered copy must FAIL and name exactly the line that owns the fault (and possibly lines that follow from it). */
function mustFail(rep: ReturnType<typeof full>, id: string) {
  assert.equal(rep.result, "FAIL");
  assert.ok(rep.failed.includes(id), `expected ${id} to fail, got: ${rep.failed.join(", ")}`);
}

test("honest: the lot owner's proof of Alice's bid passes every line with no viewing key", () => {
  const rep = full(alice);
  assert.equal(rep.result, "PASS", JSON.stringify(rep.lines, null, 1));
  assert.deepEqual(rep.lines.map((l) => l.id), ["txid-matches-bytes", "payment-opens", "bid-amount", "bid-memo", "lot-facts", "mined-height", "on-time", "counted", "result-file"]);
  assert.equal(alice.bid.amountZat, 3_000_000);
  assert.equal(alice.bid.word, "q7k2");
  assert.match(rep.sellerSays[0], /won, at a price of 1,500,000 zat, with 1,500,000 zat refunded/);
});

test("honest: the proof file holds no viewing key, and an extra field (such as a key) is refused", () => {
  const text = JSON.stringify(alice);
  assert.equal(findSecret(text), null);
  assert.ok(!text.includes(lotKey.slice(0, 30)));
  assert.throws(() => validateBidProof({ ...clone(alice), ufvk: lotKey }), (e: Error) => e instanceof InputError && /does not define: ufvk/.test(e.message));
  assert.throws(() => validateBidProof({ ...clone(alice), format: "imani-bid-proof/2" }), InputError);
});

test("honest: without lot facts, chain and result the proof opens but is NOT PROVEN, never PASS", () => {
  const rep = verifyBidProof(alice);
  assert.equal(rep.result, "NOT PROVEN");
  assert.deepEqual(rep.lines.filter((l) => l.mark === "PROVEN").map((l) => l.id), ["txid-matches-bytes", "payment-opens", "bid-amount", "bid-memo"]);
});

test("a key that cannot see the bid cannot make a proof", () => {
  assert.throws(() => makeBidProof({ facts, viewingKey: v.parties["stranger"].ufvk, txid: tx("bid_alice").txid, txHex: tx("bid_alice").txHex, height: 4200010 }), BidProofError);
  // The bidders in this offline round paid without keeping a sender copy, so their own keys see nothing either.
  assert.throws(() => makeBidProof({ facts, viewingKey: v.parties["bidder alice"].ufvk, txid: tx("bid_alice").txid, txHex: tx("bid_alice").txHex, height: 4200010 }), /sees no bid/);
});

// ---- Tampered copies. Each must FAIL on the named line. ----

test("tamper 1: a byte of the transaction changed -> txid-matches-bytes", () => {
  const p = clone(alice);
  // Offset 2000 sits in the encrypted payments, which the transaction id commits to. (Signatures and
  // zero-knowledge proofs near the end are not part of a version 5 or 6 transaction id, ZIP 244.)
  const i = 2000;
  p.txHex = p.txHex.slice(0, i) + (p.txHex[i] === "0" ? "1" : "0") + p.txHex.slice(i + 1);
  mustFail(full(p), "txid-matches-bytes");
});

test("tamper 2: the proof names another bid's transaction id -> txid-matches-bytes", () => {
  const p = clone(alice);
  p.bid.txid = tx("bid_bob").txid;
  mustFail(full(p), "txid-matches-bytes");
});

test("tamper 3: the amount raised from 3,000,000 to 4,000,000 -> bid-amount", () => {
  const p = clone(alice);
  p.bid.amountZat = 4_000_000;
  const rep = full(p);
  mustFail(rep, "bid-amount");
  assert.ok(!rep.failed.includes("payment-opens"));
});

test("tamper 4: another word claimed -> bid-memo", () => {
  const p = clone(alice);
  p.bid.word = "zzzz";
  p.bid.memo = "bid:LOT-01:zzzz";
  mustFail(full(p), "bid-memo");
});

test("tamper 5: Bob's opening key on Alice's bid -> payment-opens", () => {
  const p = clone(alice);
  p.openingKey = make("bid_bob").openingKey;
  mustFail(full(p), "payment-opens");
});

test("tamper 6: a made-up opening key -> payment-opens", () => {
  const p = clone(alice);
  p.openingKey = "11".repeat(32);
  mustFail(full(p), "payment-opens");
});

test("tamper 7: the proof points at the other action of the transaction -> payment-opens", () => {
  const p = clone(alice);
  p.bid.index = p.bid.index === 0 ? 1 : 0;
  mustFail(full(p), "payment-opens");
});

test("tamper 8: a different lot address (a stranger's) in the proof -> payment-opens and lot-facts", () => {
  const p = clone(alice);
  p.lot.lotAddress = v.parties["stranger"].address;
  const rep = full(p);
  mustFail(rep, "payment-opens");
  mustFail(rep, "lot-facts");
});

test("tamper 9: the close moved later in the proof than the seller published -> lot-facts", () => {
  const p = clone(alice);
  p.lot.closeHeight = 4200200;
  mustFail(full(p), "lot-facts");
});

test("tamper 10: the block number changed -> mined-height", () => {
  const p = clone(alice);
  p.bid.height = 4200011;
  mustFail(full(p), "mined-height");
});

test("tamper 11: an honest proof of Dave's late bid -> on-time (and the seller rightly did not count it)", () => {
  const rep = full(make("bid_dave_late"));
  mustFail(rep, "on-time");
  mustFail(rep, "counted");
  assert.ok(!rep.failed.includes("mined-height"));
});

test("tamper 12: Dave's late bid with an on-time block claimed -> mined-height", () => {
  const rep = full(make("bid_dave_late", 4200090));
  mustFail(rep, "mined-height");
});

test("tamper 13: a bid that never reached the chain -> mined-height", () => {
  const c = clone(chain);
  for (const b of c.blocks) b.txs = b.txs.filter((t) => t.txid !== alice.bid.txid);
  mustFail(full(alice, result, resultText, c), "mined-height");
});

test("tamper 14: the seller's result leaves the bid out -> counted", () => {
  const r = clone(result);
  r.bids = r.bids.filter((b: any) => b.txid !== alice.bid.txid);
  mustFail(full(alice, r, JSON.stringify(r)), "counted");
});

test("tamper 15: the seller's result counts the bid at less than was paid -> counted", () => {
  const r = clone(result);
  r.bids.find((b: any) => b.txid === alice.bid.txid).amountZat = 2_500_000;
  mustFail(full(alice, r, JSON.stringify(r)), "counted");
});

test("tamper 16: the result file shown is not the one the proof was made against -> result-file", () => {
  const r = clone(result);
  const text = JSON.stringify(r) + "\n ";
  const rep = full(alice, r, text);
  mustFail(rep, "result-file");
  assert.ok(!rep.failed.includes("counted"));
});

test("tamper 17: the proof moved to another lot name -> bid-memo and lot-facts", () => {
  const p = clone(alice);
  p.lot.lotId = "LOT-02";
  const rep = full(p);
  mustFail(rep, "bid-memo");
  mustFail(rep, "lot-facts");
});

test("tamper 18: Carol's transaction bytes and id under Alice's opening key -> payment-opens", () => {
  const p = clone(alice);
  p.txHex = tx("bid_carol").txHex;
  p.bid.txid = tx("bid_carol").txid;
  mustFail(full(p), "payment-opens");
});

// ---- The real round on the Zcash test network. ----

test("real round DRY-01: the shipped example proof passes offline against the saved real blocks", () => {
  const proof = json("examples/bid-proof-01/proof.json");
  const r = run([
    "bid-proof", "check",
    "--proof", "examples/bid-proof-01/proof.json",
    "--facts", "examples/bid-proof-01/lot-public.json",
    "--result", "examples/testnet-01/result.json",
    "--chain", "examples/testnet-01/chain.json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: PASS \(9 of 9 lines proven\)/);
  assert.match(r.stdout, /Servers contacted: none/);
  assert.equal(proof.bid.amountZat, 3_000_000);
  assert.equal(findSecret(read("examples/bid-proof-01/proof.json")), null);
});

test("real round DRY-01: the lot owner remakes the same proof with the published lot key", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-bidproof-"));
  const key = join(dir, "lot.key");
  writeFileSync(key, json("examples/testnet-01/disclosure.json").ufvk);
  const out = join(dir, "proof.json");
  const r = run([
    "bid-proof", "make",
    "--facts", "examples/bid-proof-01/lot-public.json",
    "--key-file", key,
    "--bid", "b76cd31fa4584857b84e16357e2fd6e958a59a9e63661529b52a93867ad8ed7c",
    "--disclosure", "examples/testnet-01/disclosure.json",
    "--result", "examples/testnet-01/result.json",
    "--out", out,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), json("examples/bid-proof-01/proof.json"));
});

test("the schema lists exactly the fields the checker accepts, and the example proof fits it", () => {
  const s = json("schema/bid-proof.schema.json");
  const proof = json("examples/bid-proof-01/proof.json");
  const fits = (schema: any, value: any, path: string) => {
    for (const k of schema.required ?? []) assert.ok(k in value, `${path}: missing ${k}`);
    for (const k of Object.keys(value)) assert.ok(k in schema.properties, `${path}: ${k} is not in the schema`);
    for (const [k, sub] of Object.entries<any>(schema.properties)) {
      if (!(k in value)) continue;
      if (sub.pattern) assert.match(String(value[k]), new RegExp(sub.pattern), `${path}.${k}`);
      if (sub.enum) assert.ok(sub.enum.includes(value[k]), `${path}.${k}`);
      if (sub.const) assert.equal(value[k], sub.const);
      if (sub.type === "object") fits(sub, value[k], `${path}.${k}`);
    }
  };
  fits(s, proof, "$");
  // Every field the schema names is accepted by the checker, and every nested object forbids extras.
  assert.equal(s.additionalProperties, false);
  for (const k of ["lot", "bid", "result"]) assert.equal(s.properties[k].additionalProperties, false);
});

test("command line: exit codes and refusals", () => {
  const base = ["bid-proof", "check", "--proof", "examples/bid-proof-01/proof.json"];
  assert.equal(run(base).code, 3);
  assert.equal(run([...base, "--key-file", "x"]).code, 2);
  assert.equal(run(["bid-proof", "make", "--facts", "examples/bid-proof-01/lot-public.json"]).code, 2);
  const dir = mkdtempSync(join(tmpdir(), "imani-bidproof-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...json("examples/bid-proof-01/proof.json"), ufvk: "x" }));
  const r = run(["bid-proof", "check", "--proof", bad]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /does not define: ufvk/);
  const forged = join(dir, "forged.json");
  const p = json("examples/bid-proof-01/proof.json");
  p.bid.amountZat = 30_000_000;
  writeFileSync(forged, JSON.stringify(p));
  const f = run(["bid-proof", "check", "--proof", forged, "--facts", "examples/bid-proof-01/lot-public.json", "--result", "examples/testnet-01/result.json", "--chain", "examples/testnet-01/chain.json"]);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /RESULT: FAIL \(.*bid-amount/);
});
