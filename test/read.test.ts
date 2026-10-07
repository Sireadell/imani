import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTransaction as readFull, readTransactionWithId, decoderInfo } from "../src/read.ts";

// These tests compare amount, memo and direction. Who the output went to is tested in receivers.test.ts.
const readTransaction = (tx: string, key: string) => readFull(tx, key).map(({ recipientHex: _r, ...rest }) => rest);

// A real testnet transaction from the LedgerHQ/zcash-decrypt tests: version 5, branch id
// 0x4dec4df0 (NU6.1), two Orchard change outputs. The librustzcash decoder still reads it.
// Since zcash_client_backend 0.25 the outgoing check also tries the key's Orchard outgoing
// key on Sapling outputs, so it now also finds the 1,000,000 zatoshi Sapling payment this
// wallet sent from Orchard ("Test transaction"). Ledger 0.2.0 and the 0.24 decoder missed it.
const vector = JSON.parse(readFileSync(new URL("./vectors/ledger-testnet-orchard-internal.json", import.meta.url), "utf8"));

test("reads amounts from a viewing key alone", () => {
  const out = readTransaction(vector.txHex, vector.ufvk);
  const orchard = out.filter((o) => o.pool === "orchard");
  assert.equal(orchard.length, 2);
  for (const o of orchard) {
    assert.equal(o.amountZat, 14490000);
    assert.equal(o.transferType, "internal");
  }
  assert.deepEqual(
    out.filter((o) => o.pool !== "orchard"),
    [{ pool: "sapling", amountZat: 1_000_000, memo: "Test transaction", transferType: "outgoing" }],
  );
});

test("a malformed key is rejected with a clear error", () => {
  assert.throws(() => readTransaction(vector.txHex, "not-a-key"), /UFVK decode failed/);
});

test("decoderInfo names the librustzcash versions and NU7 as the newest upgrade", () => {
  const info = decoderInfo();
  assert.equal(info.highestUpgrade, "NU7");
  assert.equal(info.highestBranchId, "0x77190ad9");
  assert.match(info.librustzcash.zcash_primitives, /^0\.31\./);
  const nu7 = info.upgrades.find((u) => u.name === "NU7");
  assert.equal(nu7?.activationHeight.test, 4_465_026);
});

// Real testnet transactions mined after NU7 activated (height 4,465,026), fetched from two
// independent sources that returned identical bytes. No key we hold can see into them.
const nu7 = JSON.parse(readFileSync(new URL("./vectors/nu7-testnet.json", import.meta.url), "utf8"));
const stranger = JSON.parse(readFileSync(new URL("./vectors/offline-vectors.json", import.meta.url), "utf8")).parties.stranger.ufvk;

test("real NU7 testnet transactions parse and their recomputed txid matches", () => {
  assert.ok(nu7.transactions.length >= 3);
  for (const t of nu7.transactions) {
    assert.ok(t.height >= 4_465_026);
    const r = readTransactionWithId(t.txHex, stranger);
    assert.equal(r.txid, t.txid);
    assert.deepEqual(r.outputs, [], "no outputs visible to the stranger key");
  }
});

test("a transaction from an unknown network upgrade is refused by name", () => {
  const raw = Buffer.from(nu7.transactions[0].txHex, "hex");
  raw.writeUInt32LE(0x12345678, 8);
  assert.throws(() => readTransaction(raw.toString("hex"), stranger), /unsupported network upgrade 0x12345678/);
});
