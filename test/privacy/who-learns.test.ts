// Who learns what in the real test-network round. Answers locked 2026-10-19 before the code was
// written, from numbers the scan tests already fixed: 34 blocks, 80 transactions, 6 seen by the
// lot key (3 bids, 3 refunds), no refund link outside the round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { whoLearns, whoLearnsMarkdown } from "../../src/privacy/who-learns.ts";

const ex = (p: string) => JSON.parse(readFileSync(new URL(`../../examples/testnet-01/${p}`, import.meta.url), "utf8"));
const rep = whoLearns(ex("disclosure.json"), ex("chain.json"));

test("the numbers come from the real round", () => {
  assert.equal(rep.blocks, 34);
  assert.equal(rep.transactionsInRange, 80);
  assert.equal(rep.lotTransactions, 6);
  assert.equal(rep.bids, 3);
  assert.equal(rep.refunds, 3);
  assert.equal(rep.linksOutside, 0);
});

test("every party has a row, and the onlooker without the key learns no amount", () => {
  const parties = rep.rows.map((r) => r.party);
  assert.deepEqual(parties, ["Anyone, without the lot key", "Anyone, once the seller publishes the lot key", "The seller", "Each bidder", "This page and its host"]);
  const onlooker = rep.rows[0];
  assert.match(onlooker.learns, /80 shielded transactions in 34 blocks/);
  assert.match(onlooker.cannotLearn, /which 6 belong to this auction/);
  assert.doesNotMatch(onlooker.learns, /zat|ZEC/);
});

test("the published table in docs matches what the code generates", () => {
  const doc = readFileSync(new URL("../../docs/WHO_LEARNS_WHAT.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(doc.includes(whoLearnsMarkdown(rep)), "docs/WHO_LEARNS_WHAT.md is out of date: run npm run who-learns");
});

test("the page shows the same table", () => {
  const html = readFileSync(new URL("../../src/site/static/index.html", import.meta.url), "utf8");
  for (const r of rep.rows) {
    assert.ok(html.includes(r.party), r.party);
    assert.ok(html.includes(r.learns), r.learns);
  }
});
