// How far a refund can be followed. Answers locked 2026-10-19 before the code was written, from
// facts already proven by the checker: in testnet-01 each of 3 refunds went to the address its
// bidder wrote (refund-receivers PASS) and the 3 addresses differ; in memo-01 each of 4 refunds
// went to its bidder's address and the 4 addresses differ; receivers-01 pays the same 4 addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { linkingFromLots, type LotRefunds } from "../../src/privacy/linking.ts";
import { run } from "../../src/cli.ts";

const path = (p: string) => fileURLToPath(new URL(`../../examples/${p}/disclosure.json`, import.meta.url));
const linking = (...lots: string[]) => run(["linking", ...lots.map(path)]);

test("testnet-01: 3 of 3 refunds link to their bid inside the round, none reach outside it", () => {
  const r = linking("testnet-01");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Refunds that name their bid: 3 of 3/);
  assert.match(r.stdout, /Different refund receivers: 3/);
  assert.match(r.stdout, /Receivers paid more than once in this round: 0/);
  assert.match(r.stdout, /Receivers seen in more than one round: 0/);
  assert.match(r.stdout, /RESULT: NO LINKS OUTSIDE THE ROUND/);
  assert.match(r.stdout, /Servers contacted: none/);
});

test("memo-01: 4 of 4 refunds link to their bid, 4 different receivers", () => {
  const r = linking("memo-01");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Refunds that name their bid: 4 of 4/);
  assert.match(r.stdout, /Different refund receivers: 4/);
  assert.match(r.stdout, /RESULT: NO LINKS OUTSIDE THE ROUND/);
});

test("memo-01 and receivers-01 together: the same 4 bidders can be followed from one round to the other", () => {
  const r = linking("memo-01", "receivers-01");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Receivers seen in more than one round: 4/);
  assert.match(r.stdout, /RESULT: 4 LINKS BETWEEN ROUNDS/);
});

test("the same lot given twice is refused", () => {
  const r = linking("testnet-01", "testnet-01");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /given twice/);
});

test("no file given prints the usage", () => {
  assert.equal(run(["linking"]).code, 2);
});

test("a receiver paid for two different bids in one round is reported as one bidder seen twice", () => {
  const lot: LotRefunds = {
    lotId: "L",
    bids: ["a", "b", "c"],
    refunds: [
      { bidTxid: "a", receiver: "r1" },
      { bidTxid: "b", receiver: "r1" },
      { bidTxid: "c", receiver: "r2" },
    ],
  };
  const rep = linkingFromLots([lot]);
  assert.equal(rep.lots[0].receivers, 2);
  assert.deepEqual(rep.lots[0].reusedInRound, [{ receiver: "r1", bids: ["a", "b"] }]);
  assert.equal(rep.linksOutside, 1);
});

test("the report never prints the lot key", () => {
  const r = linking("testnet-01");
  assert.doesNotMatch(r.stdout, /uview/);
});
