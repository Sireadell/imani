// A real sign-in on the Zcash test network, replayed offline. examples/real-login/round.json holds one
// payment that a real wallet (zecd 0.9.0-rc1, throwaway keys, free faucet coins) sent to a site address on
// 2026-10-19, with a login memo made by this repo's kit. Nothing here is invented: the bytes are the ones
// the network mined. The check uses only the site's read-only viewing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryChallengeStore, verifyLoginPayment } from "../../src/login/index.ts";
import { readTransaction } from "../../src/read.ts";

const round = JSON.parse(readFileSync(new URL("../../examples/real-login/round.json", import.meta.url), "utf8"));
const opts = (over: Record<string, unknown> = {}) => ({ siteId: round.siteId, siteAddress: round.siteAddress, proof: round.proof, now: round.checkedAt, ...over });
function freshStore() {
  const s = new MemoryChallengeStore();
  s.put(round.challenge);
  return s;
}

test("the recorded payment is a real test-network transaction the site's viewing key can read", () => {
  assert.equal(round.network, "test");
  assert.match(round.txid, /^[0-9a-f]{64}$/);
  assert.ok(round.blockHeight > 4_465_026, "mined after the NU7 upgrade on the test network");
  const outs = readTransaction(round.txHex, round.siteViewingKey);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].amountZat, round.amountZat);
  assert.ok(outs[0].memo.startsWith("imani-login:1\n"));
});

test("sign-in with the real payment works and the site learns only the account id, the amount and the pool", async () => {
  const r = await verifyLoginPayment(round.txHex, round.siteViewingKey, freshStore(), opts());
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.siteLearned, { accountId: round.accountId, amountZat: 10_000, pool: "ironwood" });
});

test("the same real payment cannot sign in twice", async () => {
  const store = freshStore();
  assert.equal((await verifyLoginPayment(round.txHex, round.siteViewingKey, store, opts())).ok, true);
  const again = await verifyLoginPayment(round.txHex, round.siteViewingKey, store, opts());
  assert.equal(again.ok, false);
});

test("someone who only holds the public transaction cannot sign in as the owner", async () => {
  const r = await verifyLoginPayment(round.txHex, round.siteViewingKey, freshStore(), opts({ proof: undefined }));
  assert.deepEqual(r.ok === false && r.reason, "bad_proof");
});

test("the real payment is refused after the code expires and by a different site", async () => {
  const late = await verifyLoginPayment(round.txHex, round.siteViewingKey, freshStore(), opts({ now: round.challenge.expiresAt + 1 }));
  assert.deepEqual(late.ok === false && late.reason, "code_expired");
  const other = await verifyLoginPayment(round.txHex, round.siteViewingKey, freshStore(), opts({ siteId: "other.example" }));
  assert.deepEqual(other.ok === false && other.reason, "wrong_site");
});
