import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkExternalRound, detectExternalRound, externalRoundText, ExternalRoundInputError } from "../../src/external/published-round.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./round-files/${name}.json`, import.meta.url), "utf8"));
const failed = (r: ReturnType<typeof checkExternalRound>) => r.lines.filter((l) => l.status === "FAIL").map((l) => l.id);

test("a real published DEMO-01 settlement adds up under its own rule", () => {
  const r = checkExternalRound(load("demo01-settlement"));
  assert.equal(r.result, "PASS");
  assert.equal(r.kind, "settlement");
  assert.equal(r.lines.length, 6);
  assert.deepEqual(r.serversContacted, []);
  assert.match(r.notes.join(" "), /0\.0032/);
});

test("the published DEMO reveal file passes, and its tampered file fails on the refund amount", () => {
  assert.equal(checkExternalRound(load("reveal")).result, "PASS");
  const t = checkExternalRound(load("tampered"));
  assert.equal(t.result, "FAIL");
  assert.deepEqual(failed(t), ["refund-amounts"]);
  assert.match(t.lines.find((l) => l.id === "refund-amounts")!.detail, /bid 1\.5 but refund 1\.55/);
});

test("settlement: each wrong number is caught by its own check", () => {
  const cases: [string, (d: any) => void, string[]][] = [
    ["a higher bid listed as a loser", (d) => { d.settlement[1].result = "lose"; d.settlement[2].result = "win"; }, ["winners-are-highest", "clearing-price", "rows-add-up"]],
    ["wrong price", (d) => { d.clearing_price = "0.004"; }, ["clearing-price", "rows-add-up", "totals"]],
    ["a winner pays too little", (d) => { d.settlement[0].pays = "0.008"; d.settlement[0].refund = "0.004"; }, ["rows-add-up"]],
    ["a loser refunded too little", (d) => { d.settlement[2].refund = "0.003"; }, ["rows-add-up"]],
    ["seller payout overstated", (d) => { d.payout_to_seller = "0.019"; }, ["totals"]],
    ["bid count wrong", (d) => { d.bids_received = 4; }, ["bid-count"]],
    ["a bid listed twice", (d) => { d.settlement[2].txid = d.settlement[1].txid; }, ["no-duplicates"]],
  ];
  for (const [name, change, expected] of cases) {
    const d = load("demo01-settlement");
    change(d);
    const got = failed(checkExternalRound(d));
    for (const id of expected) assert.ok(got.includes(id), `${name}: expected ${id} to fail, got ${got.join(",")}`);
  }
  // The single-fault cases fail only the check they name.
  const d = load("demo01-settlement");
  d.bids_received = 4;
  assert.deepEqual(failed(checkExternalRound(d)), ["bid-count"]);
});

test("reveal: a missing refund, a refunded winner and a wrong price are each caught", () => {
  let d = load("reveal");
  d.refunds = d.refunds.filter((x: any) => x.txid[0] !== "b");
  assert.deepEqual(failed(checkExternalRound(d)), ["refund-amounts"]);
  d = load("reveal");
  d.refunds.push({ txid: "e".repeat(64), amount_zec: "2", kind: "outbid_refund" });
  assert.deepEqual(failed(checkExternalRound(d)), ["winners-not-refunded"]);
  d = load("reveal");
  d.clearing_zec = "1.55";
  assert.deepEqual(failed(checkExternalRound(d)), ["clearing-price"]);
  d = load("reveal");
  d.received[0].status = "refunded";
  d.received[1].status = "winner";
  assert.ok(failed(checkExternalRound(d)).includes("winners-are-highest"));
});

test("a tie at the edge of the winners does not need a tie rule", () => {
  const d = load("demo01-settlement");
  d.settlement[2].amount = "0.009";
  d.settlement[2].refund = "0.009";
  d.escrow_bids_total = "0.030";
  d.total_refund = "0.012";
  assert.equal(checkExternalRound(d).result, "PASS");
});

test("decimal amounts are read exactly, without floating point", () => {
  const d = load("demo01-settlement");
  d.settlement[0].amount = "0.30000000";
  d.settlement[0].refund = "0.29100000";
  d.escrow_bids_total = "0.313";
  d.total_refund = "0.295";
  assert.equal(checkExternalRound(d).result, "PASS");
});

test("files that are not in a format imani reads, or have bad numbers, are refused by name", () => {
  assert.equal(detectExternalRound({}), null);
  assert.equal(detectExternalRound(load("reveal")), "reveal");
  assert.throws(() => checkExternalRound({ hello: 1 }), ExternalRoundInputError);
  const d = load("demo01-settlement");
  d.reserve = "0,003";
  assert.throws(() => checkExternalRound(d), /reserve is not a ZEC amount/);
  const e = load("reveal");
  delete e.received[0].txid;
  assert.throws(() => checkExternalRound(e), /txid is missing/);
});

test("the text report ends with the result and says what it does not cover", () => {
  const text = externalRoundText(checkExternalRound(load("tampered")));
  assert.match(text, /Servers contacted: none/);
  assert.match(text, /Not checked: that these amounts are what was really paid on the chain/);
  assert.match(text, /RESULT: FAIL$/);
});
