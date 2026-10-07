// Threat: someone who sees the login payment link or QR (shoulder-surfing, a screenshot, a shared page)
// or the one-time code on the page. Before the fix, paying the copied memo first and sending that payment
// to the site logged the attacker in as the victim (this file's first version proved it). Now the site also
// needs a proof that only the account key can make, and it never travels in the link.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LoginKit,
  MemorySessions,
  buildLoginMemo,
  buildLoginProof,
  createChallenge,
  MemoryChallengeStore,
  parseLoginMemo,
  proofText,
  verifyLoginPayment,
  zcashLogin,
} from "../../src/login/index.ts";
import { FAKE_ADDRESS, FAKE_UFVK, SITE, T0, fakeChain, fixedKey, fixedRandom } from "./helpers.ts";
import { fakeReq, run } from "./fakes.ts";

async function setup(accountId?: string) {
  const store = new MemoryChallengeStore();
  const chain = fakeChain();
  const c = await createChallenge(store, { siteId: SITE, siteAddress: FAKE_ADDRESS, network: "test", now: T0, random: fixedRandom("fr"), accountId });
  const verify = (tx: string, proof?: string) =>
    verifyLoginPayment(tx, FAKE_UFVK, store, { siteId: SITE, siteAddress: FAKE_ADDRESS, now: T0 + 5, readTx: chain.readTx, proof });
  return { store, chain, c, verify };
}

const victim = fixedKey("victim");
const attacker = fixedKey("attacker");

test("a copied memo, paid from the attacker's wallet, does not log the attacker in as the victim", async () => {
  const { chain, c, verify } = await setup();
  const copiedMemo = buildLoginMemo(victim, c); // read off the link or QR
  const tx = chain.pay(copiedMemo);
  // No proof, a proof made by the attacker's own key, and the memo's signature reused as a proof: all refused.
  assert.equal((await verify(tx)).ok, false);
  const own = await verify(tx, buildLoginProof(attacker, c));
  assert.equal(!own.ok && own.reason, "bad_proof");
  const parsed = parseLoginMemo(copiedMemo);
  const reused = await verify(tx, parsed.ok ? parsed.memo.signature : "");
  assert.equal(!reused.ok && reused.reason, "bad_proof");
  // Nothing was burned: the victim's own payment still logs the victim in.
  const real = await verify(chain.pay(copiedMemo), buildLoginProof(victim, c));
  assert.equal(real.ok && real.accountId, victim.siteKey(SITE).publicKey);
});

test("the proof is bound to the site and the code: one made for another code or site is worthless", async () => {
  const { chain, c, verify } = await setup();
  const tx = chain.pay(buildLoginMemo(victim, c));
  const otherCode = buildLoginProof(victim, { ...c, nonce: "2222-3333-4444-5555-6666" });
  const otherSite = buildLoginProof(victim, { ...c, siteId: "other.example" });
  assert.equal((await verify(tx, otherCode)).ok, false);
  assert.equal((await verify(tx, otherSite)).ok, false);
  assert.notEqual(proofText(SITE, c.nonce), proofText("other.example", c.nonce));
});

test("someone who submits the victim's public payment without the proof burns neither the payment nor the code", async () => {
  const { chain, c, verify } = await setup();
  const tx = chain.pay(buildLoginMemo(victim, c));
  for (let i = 0; i < 3; i++) assert.equal((await verify(tx)).ok, false);
  const real = await verify(tx, buildLoginProof(victim, c));
  assert.equal(real.ok, true, "the real user can still submit the same payment");
});

test("a code reserved for an account id cannot be burned by anyone else, even with a full valid login of their own", async () => {
  const { chain, c, verify } = await setup(victim.siteKey(SITE).publicKey);
  // The attacker only saw the code. They pay it with their own key and their own proof.
  const mine = await verify(chain.pay(buildLoginMemo(attacker, c)), buildLoginProof(attacker, c));
  assert.equal(!mine.ok && mine.reason, "wrong_account");
  const real = await verify(chain.pay(buildLoginMemo(victim, c)), buildLoginProof(victim, c));
  assert.equal(real.ok && real.accountId, victim.siteKey(SITE).publicKey);
});

test("limit that remains: an unreserved code can be used first by anyone who knows it, with their own key", async () => {
  const { chain, c, verify } = await setup();
  const mine = await verify(chain.pay(buildLoginMemo(attacker, c)), buildLoginProof(attacker, c));
  assert.equal(mine.ok && mine.accountId, attacker.siteKey(SITE).publicKey, "they get their own account, not the victim's");
  const late = await verify(chain.pay(buildLoginMemo(victim, c)), buildLoginProof(victim, c));
  assert.equal(!late.ok && late.reason, "code_already_used", "but the victim's code is gone");
});

test("end to end through the Express add-on: reserved code, proof in the request, not in the memo", async () => {
  const chain = fakeChain();
  const kit = new LoginKit({ siteId: SITE, siteAddress: FAKE_ADDRESS, viewingKey: FAKE_UFVK, readTx: chain.readTx, clock: () => T0 });
  const mw = zcashLogin({ kit, sessions: new MemorySessions(), secureCookie: false });
  const id = victim.siteKey(SITE).publicKey;
  const ch = (await run(mw, fakeReq("POST", "/zcash-login/challenge", { body: { accountId: id } }))).json;
  assert.equal(ch.accountId, id);
  const memo = buildLoginMemo(victim, ch);
  assert.ok(!memo.includes(buildLoginProof(victim, ch)), "the proof never appears in the memo");
  const tx = chain.pay(memo);
  const stolen = await run(mw, fakeReq("POST", "/zcash-login/verify", { body: { txHex: tx } }));
  assert.equal(stolen.res.statusCode, 401);
  assert.equal(stolen.json.reason, "bad_proof");
  assert.equal(stolen.res.headers["set-cookie"], undefined);
  const ok = await run(mw, fakeReq("POST", "/zcash-login/verify", { body: { txHex: tx, proof: buildLoginProof(victim, ch) } }));
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.json.accountId, id);
  const bad = await run(mw, fakeReq("POST", "/zcash-login/challenge", { body: {} }));
  assert.equal(bad.res.statusCode, 400);
  const badId = await run(mw, fakeReq("POST", "/zcash-login/challenge", { body: { accountId: "short" } }));
  assert.equal(badId.res.statusCode, 400);
});
