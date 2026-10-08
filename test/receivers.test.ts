import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLot, InputError } from "../src/check.ts";
import { run } from "../src/cli.ts";
import { parseAddress, readTransaction } from "../src/read.ts";

const ex = (p: string) => new URL(`../examples/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(ex(p), "utf8"));
const load = (dir: string) => ({ d: json(`${dir}/disclosure.json`), r: json(`${dir}/result.json`) });
const vectors = JSON.parse(readFileSync(new URL("./vectors/auction-round.json", import.meta.url), "utf8"));
const party = (name: string) => vectors.parties[name];
const lotKey: string = party("lot LOT-01").ufvk;

test("the reader returns who each output was paid to", () => {
  const refund = readTransaction(vectors.transactions.refund_alice_change.txHex, lotKey).find((o) => o.transferType === "outgoing")!;
  assert.equal(refund.recipientHex, parseAddress(party("bidder alice").address).orchard);
  assert.notEqual(refund.recipientHex, parseAddress(party("bidder bob").address).orchard);
  assert.equal(refund.recipientHex.length, 86);
  const bid = readTransaction(vectors.transactions.bid_alice.txHex, lotKey).find((o) => o.transferType === "incoming")!;
  assert.equal(bid.recipientHex, parseAddress(party("lot LOT-01").address).orchard);
});

test("parseAddress splits an address into receivers and refuses anything else", () => {
  const a = parseAddress(party("bidder carol").address);
  assert.equal(a.network, "test");
  assert.match(a.orchard!, /^[0-9a-f]{86}$/);
  assert.throws(() => parseAddress("not-an-address"), /address decode failed/);
  assert.throws(() => parseAddress(""), /address decode failed/);
});

test("receivers-01: every refund went to the address listed for its bid", () => {
  const { d, r } = load("receivers-01");
  const v = checkLot(d, r);
  assert.equal(v.result, "PASS");
  assert.equal(v.checks.length, 16);
  assert.equal(v.checks.find((c) => c.id === "refund-receivers")!.status, "PASS");
});

test("a disclosure without refundAddresses is unchanged: 15 checks, no receiver check", () => {
  const { d, r } = load("round-01");
  const v = checkLot(d, r);
  assert.equal(v.checks.length, 15);
  assert.ok(!v.checks.some((c) => c.id === "refund-receivers"));
});

const manifest = json("receivers-broken/manifest.json");
test("there are two broken receiver copies", () => assert.equal(manifest.copies.length, 2));
for (const copy of manifest.copies) {
  test(`receivers-broken/${copy.name} fails exactly ${copy.expectedFailingCheck}`, () => {
    const dir = `receivers-broken/${copy.name}`;
    const { d, r } = load(dir);
    const v = checkLot(d, r);
    assert.equal(v.result, "FAIL");
    assert.deepEqual(v.failed, [copy.expectedFailingCheck]);
    const res = run(["check", "--disclosure", fileURLToPath(ex(`${dir}/disclosure.json`)), "--result", fileURLToPath(ex(`${dir}/result.json`))]);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /RESULT: FAIL \(1 of 16 checks failed: refund-receivers\)/);
  });
}

test("the mismatch names the bid and the refund, and says nothing about addresses", () => {
  const { d, r } = load("receivers-broken/01-refund-to-other-address");
  const c = checkLot(d, r).checks.find((c) => c.id === "refund-receivers")!;
  assert.match(c.reason, /went to a different address than the one given for that bid/);
  assert.ok(!c.reason.includes("utest1"));
  const hidden = checkLot(d, r, { discreet: true }).checks.find((c) => c.id === "refund-receivers")!;
  assert.doesNotMatch(hidden.reason, /1,500,000/);
});

test("other receiver faults each fail the receiver check", () => {
  const { d, r } = load("receivers-01");
  const bob = party("bidder bob").address;
  const aliceBid = d.refundAddresses[0].bidTxid;
  const cases: [string, (x: any) => void, RegExp][] = [
    ["a listed address that is not an address", (x) => (x.refundAddresses[0].address = "hello"), /not a usable shielded address/i],
    ["an address for a bid that does not exist", (x) => x.refundAddresses.push({ bidTxid: "ab".repeat(32), address: bob }), /not a bid the lot key sees/i],
    ["two addresses for one bid", (x) => x.refundAddresses.push({ bidTxid: aliceBid, address: bob }), /two refund addresses/i],
    ["an address on the other network", (x) => (x.refundAddresses[0].address = "u1" + "q".repeat(100)), /usable shielded address|network/],
  ];
  for (const [name, change, why] of cases) {
    const copy = JSON.parse(JSON.stringify(d));
    change(copy);
    const v = checkLot(copy, r);
    assert.deepEqual(v.failed, ["refund-receivers"], name);
    assert.match(v.checks.find((c) => c.id === "refund-receivers")!.reason, why, name);
  }
});

test("a malformed refundAddresses list is an input error", () => {
  const { d, r } = load("receivers-01");
  for (const bad of ["x", [{ bidTxid: "short", address: "a" }], [{ bidTxid: "ab".repeat(32) }]]) {
    assert.throws(() => checkLot({ ...d, refundAddresses: bad }, r), InputError);
  }
});

test("the basic level alone does not run the receiver check", () => {
  const { d, r } = load("receivers-01");
  const v = checkLot(d, r, { basicOnly: true });
  assert.ok(!v.checks.some((c) => c.id === "refund-receivers"));
});
