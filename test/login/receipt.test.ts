// The "what this site learned" receipt is read from the kit's real storage and counts how often
// secrets appear in it. These tests log in for real (fake chain), then check the receipt, and then
// plant a leak to show the receipt would catch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginKit, buildLoginMemo, buildLoginProof, buildReceipt, receiptClean, receiptText, MemoryChallengeStore, exportAccountKey } from "../../src/login/index.ts";
import { FAKE_ADDRESS, FAKE_UFVK, T0, fakeChain, fixedKey } from "./helpers.ts";

const SITE = "shop.example";

async function loggedIn() {
  const chain = fakeChain();
  const store = new MemoryChallengeStore();
  const kit = new LoginKit({ siteId: SITE, siteAddress: FAKE_ADDRESS, viewingKey: FAKE_UFVK, store, clock: () => T0 + 5, readTx: chain.readTx });
  const user = fixedKey("receipt user");
  const site = user.siteKey(SITE);
  // The page reserves the code for its own account id, as the shipped pages do.
  const c = await kit.newChallenge(site.publicKey);
  const memo = buildLoginMemo(user, c);
  const proof = buildLoginProof(user, c);
  const r = await kit.verify(chain.pay(memo), proof);
  assert.ok(r.ok);
  return { kit, store, user, memo, proof, accountId: site.publicKey, seed: exportAccountKey(user) };
}

test("the receipt lists what the site stored for the account and finds no secret in it", async () => {
  const { kit, user, memo, accountId, seed } = await loggedIn();
  const r = kit.receipt(accountId, {
    held: [{ where: "session cookie", text: `s1.${accountId}.mac` }],
    probes: [
      { label: "your account key", value: seed },
      { label: "your login memo", value: memo },
      { label: "your wallet address", value: "utest1walletaddressthesitemustnevertake" },
    ],
  });
  assert.equal(r.accountId, accountId);
  assert.ok(r.stored.some((f) => f.field === "account id" && f.value === accountId));
  assert.ok(r.stored.some((f) => f.where === "session cookie"));
  assert.equal(r.shared[0].value, "1"); // one used transaction, not tied to any account
  assert.deepEqual(r.notStored.map((n) => n.label), ["your account key", "your login memo", "your wallet address", "the site's own viewing key"]);
  assert.ok(r.notStored.every((n) => n.found === 0));
  assert.ok(receiptClean(r));
  assert.ok(r.scanned >= 3);
  // The words a visitor reads never include a probe value.
  const text = receiptText(r);
  for (const secret of [seed, memo, FAKE_UFVK, user.siteKey(SITE).publicKey + "x"]) assert.ok(!text.includes(secret));
  assert.match(text, /found in 0/);
});

test("the receipt only lists the account's own records, but scans every record for leaks", async () => {
  const { kit, accountId } = await loggedIn();
  const other = fixedKey("someone else").siteKey(SITE).publicKey;
  await kit.newChallenge(other); // another visitor's reserved code
  const r = kit.receipt(accountId);
  assert.ok(r.stored.every((f) => f.where.startsWith("login code record")));
  assert.equal(new Set(r.stored.map((f) => f.where)).size, 1);
  assert.ok(!r.stored.some((f) => f.value === other));
  assert.equal(r.scanned, 2 + 1); // two codes, one used transaction
});

test("the receipt catches a planted leak", async () => {
  const { kit, accountId, memo } = await loggedIn();
  const r = kit.receipt(accountId, {
    held: [{ where: "debug log", text: `debug: ${memo}` }],
    probes: [{ label: "your login memo", value: memo }],
  });
  assert.equal(r.notStored.find((n) => n.label === "your login memo")?.found, 1);
  assert.equal(receiptClean(r), false);
  assert.match(receiptText(r), /your login memo: found in 1/);
});

test("a store that cannot list what it holds is refused, not guessed at", () => {
  const dumb = { put() {}, get() { return undefined; }, consume() { return false; }, markTransactionUsed() { return true; } };
  assert.throws(() => buildReceipt({ siteId: SITE, accountId: "x", store: dumb }), /cannot list what it holds/);
});
