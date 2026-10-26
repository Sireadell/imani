import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { anchorLive, anchorRecorded, anchorText, listedTxids, type RecordedChain } from "../../src/external/anchor.ts";
import { ExternalRoundInputError } from "../../src/external/published-round.ts";
import { FetchError } from "../../src/fetch/index.ts";

const dir = new URL("./round-files/", import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const settlement = read("demo01-settlement.json");
const saved = (): RecordedChain => read("demo01-chain.json");

test("a saved copy of the real mainnet fetch passes all three chain checks, offline", () => {
  const r = anchorRecorded(settlement, saved());
  assert.equal(r.result, "PASS");
  assert.deepEqual(r.lines.map((l) => l.id), ["txids-on-chain", "two-operators-agree", "mined"]);
  assert.equal(r.transactions.length, 3);
  assert.deepEqual(r.transactions.map((t) => t.height), [3499413, 3499451, 3499451]);
  assert.deepEqual(r.serversContacted, []);
  assert.match(anchorText(r), /Servers contacted: none/);
  assert.match(anchorText(r), /RESULT: PASS/);
});

test("a listed transaction id that is not in the saved chain fails txids-on-chain", () => {
  const f = structuredClone(settlement);
  f.settlement[0].txid = "00".repeat(32);
  const r = anchorRecorded(f, saved());
  assert.equal(r.result, "FAIL");
  assert.equal(r.lines.find((l) => l.id === "txids-on-chain")!.status, "FAIL");
});

test("one changed byte in a saved transaction fails txids-on-chain", () => {
  const c = saved();
  const h = c.transactions[0].hex;
  c.transactions[0].hex = h.slice(0, 200) + (h[200] === "0" ? "1" : "0") + h.slice(201);
  const r = anchorRecorded(settlement, c);
  assert.equal(r.result, "FAIL");
  assert.match(r.lines[0].detail, /do not match/);
});

test("a transaction confirmed by only one operator fails two-operators-agree", () => {
  const c = saved();
  c.transactions[1].confirmedBy = [c.transactions[1].confirmedBy[0]];
  const r = anchorRecorded(settlement, c);
  assert.equal(r.result, "FAIL");
  assert.equal(r.lines.find((l) => l.id === "two-operators-agree")!.status, "FAIL");
});

test("a transaction with no block height fails mined", () => {
  const c = saved();
  delete c.transactions[2].height;
  const r = anchorRecorded(settlement, c);
  assert.equal(r.result, "FAIL");
  assert.equal(r.lines.find((l) => l.id === "mined")!.status, "FAIL");
});

test("a round on another network, or a file with no network, is refused with a plain message", () => {
  const t = structuredClone(settlement);
  t.network = "testnet";
  assert.throws(() => anchorRecorded(t, saved()), (e: Error) => e instanceof ExternalRoundInputError && /main network but the round ran on test|saved copy is for/.test(e.message));
  const n = structuredClone(settlement);
  delete n.network;
  assert.throws(() => listedTxids(n), /does not say which network/);
  assert.throws(() => listedTxids({ nothing: 1 }), /not a reveal file or settlement file/);
});

test("live mode asks the servers for exactly the listed ids and reports a failed fetch as FAIL", async () => {
  let asked: string[] = [];
  const c = saved();
  const ok = await anchorLive(settlement, async (o) => {
    asked = o.txids;
    assert.equal(o.network, "main");
    return { transactions: c.transactions.map((t) => ({ ...t, server: t.confirmedBy[0] })), serversContacted: c.transactions[0].confirmedBy, problems: [] };
  });
  assert.equal(asked.length, 3);
  assert.equal(ok.report.result, "PASS");
  assert.equal(ok.report.source, "live");
  const failed = await anchorLive(settlement, async () => {
    throw new FetchError("could not verify 56bb6efa5a on two servers", ["https://zec.rocks:443"], []);
  });
  assert.equal(failed.report.result, "FAIL");
  assert.deepEqual(failed.report.serversContacted, ["https://zec.rocks:443"]);
});

test("the saved mainnet copy is tied to the real transactions (ids hash from the bytes)", () => {
  const r = anchorRecorded(settlement, saved());
  assert.equal(r.lines[0].status, "PASS");
  assert.equal(r.transactions[0].txid.slice(0, 10), "56bb6efa5a");
});
