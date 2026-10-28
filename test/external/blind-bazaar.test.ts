import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BlindBazaarInputError, checkBlindBazaarLot } from "../../src/external/blind-bazaar.ts";

const dir = new URL("../../examples/external-lots/blind-bazaar-testnet-ejp8jz0s/", import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const lot = () => read("lot.json");
const result = () => read("result.json");
const chain = read("chain.json");
const failed = (r: ReturnType<typeof checkBlindBazaarLot>) => r.lines.filter((l) => l.status === "FAIL").map((l) => l.id);

test("the published lot passes: two deposits of 1,000,000, both reveals open, the 3,000,000 bid wins at its own price", () => {
  const r = checkBlindBazaarLot(lot(), result(), chain);
  assert.equal(r.result, "PASS");
  assert.equal(r.lines.length, 6);
  assert.deepEqual(r.payments.map((p) => [p.txid.slice(0, 8), p.height, p.amountZat]), [["59ec5bba", 4530073, 1_000_000], ["3bf92156", 4530076, 1_000_000]]);
});

test("the project's own tampered result fails on the price", () => {
  const r = checkBlindBazaarLot(lot(), read("result-tampered.json"), chain);
  assert.equal(r.result, "FAIL");
  assert.deepEqual(failed(r), ["winner-and-price"]);
});

test("a result that names the other bid as the winner fails", () => {
  const res = result();
  res.winning_txid = "3bf92156f95bedca7b85d6f99a3301c610fdc16ad9890a16a9c2bb58e9072e2b";
  assert.deepEqual(failed(checkBlindBazaarLot(lot(), res, chain)), ["winner-and-price"]);
});

test("a reveal with the wrong salt does not open any commitment", () => {
  const res = result();
  res.audit.reveals[0].salt = "00000000000000000000000000000000";
  const f = failed(checkBlindBazaarLot(lot(), res, chain));
  assert.ok(f.includes("reveals-open-commitments"));
});

test("a bid revealed higher than the one paid for does not open its commitment", () => {
  const res = result();
  res.audit.reveals[1].bid_zats = 3_500_000;
  assert.ok(failed(checkBlindBazaarLot(lot(), res, chain)).includes("reveals-open-commitments"));
});

test("a block file with one block missing is refused as incomplete", () => {
  const c = { ...chain, blocks: chain.blocks.filter((b: { height: number }) => b.height !== 4530080) };
  assert.deepEqual(failed(checkBlindBazaarLot(lot(), result(), c)), ["blocks-read"]);
});

test("a bid that lands after the close is flagged", () => {
  const l = lot();
  l.close_height = 4530074;
  assert.ok(failed(checkBlindBazaarLot(l, result(), chain)).includes("on-time"));
});

test("a different deposit is flagged", () => {
  const l = lot();
  l.deposit_zats = 1_500_000;
  assert.ok(failed(checkBlindBazaarLot(l, result(), chain)).includes("deposits"));
});

test("input that is not a one-item first-price lot is refused", () => {
  const l = lot();
  l.units = 3;
  assert.throws(() => checkBlindBazaarLot(l, result(), chain), BlindBazaarInputError);
});
