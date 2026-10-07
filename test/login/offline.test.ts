// End to end on real Zcash transaction bytes, offline. The transactions in
// vectors/login-offline.json were built by tools/gen-vectors/gen_login.rs with the
// librustzcash builder: throwaway keys, invented funding, never broadcast.
// Each one pays the site's address with a login memo and sends change back to the
// paying wallet's own address. The site reads it with only its viewing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTransaction } from "../../src/read.ts";
import { buildLoginProof, buildPaymentUri, checkSinglePayee, verifyLoginPayment, MemoryChallengeStore, type Challenge } from "../../src/login/index.ts";
import { T0, fixedKey } from "./helpers.ts";
import { PAYMENTS, SITE_ADDRESS, SITE_ID, memoFor, proofsByLabel, siteCodes } from "./offline-plan.ts";

const P = await proofsByLabel();

const v = JSON.parse(readFileSync(new URL("./vectors/login-offline.json", import.meta.url), "utf8"));
const site = v.parties["site shop.example"];
const tx = (label: string): string => v.transactions[label].txHex;
const NOW = T0 + 60;

async function freshSite() {
  const store = new MemoryChallengeStore();
  const { codes } = await siteCodes(store);
  const verify = (label: string, now = NOW) => verifyLoginPayment(tx(label), site.ufvk, store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, now, proof: P[label] });
  return { store, codes, verify };
}

test("vector inputs match today's memo builder (the memos inside the transactions are ours)", async () => {
  const { codes } = await siteCodes();
  const inputs = JSON.parse(readFileSync(new URL("./vectors/login-inputs.json", import.meta.url), "utf8"));
  assert.equal(site.address, SITE_ADDRESS);
  for (const [i, p] of PAYMENTS.entries()) assert.equal(inputs.payments[i].memo, memoFor(p, codes), p.label);
  assert.deepEqual(v.inputs, inputs);
});

test("the site's viewing key reads each login memo exactly as librustzcash does", () => {
  for (const [label, t] of Object.entries<any>(v.transactions)) {
    const viewer = v.parties[t.to].ufvk;
    const want = t.siteKeySees.map((o: any) => ({ pool: o.pool, amountZat: o.amountZat, memo: o.memo, transferType: o.transferType.toLowerCase() }));
    assert.deepEqual(readTransaction(t.txHex, viewer), want, label);
  }
});

test("the two paying wallets are different senders with different addresses", () => {
  const a = v.transactions.login_wallet_a;
  const b = v.transactions.login_wallet_b;
  assert.notEqual(a.walletAddress, b.walletAddress);
  assert.equal(a.wallet, "user wallet A");
  assert.equal(b.wallet, "user wallet B");
  // Each wallet's own key sees its change; the other wallet's key sees nothing of it.
  const wa = v.parties["user wallet A"].ufvk;
  const wb = v.parties["user wallet B"].ufvk;
  assert.ok(readTransaction(a.txHex, wa).length > 0);
  assert.deepEqual(readTransaction(a.txHex, wb), []);
  assert.deepEqual(readTransaction(b.txHex, wa), []);
});

test("full flow: code, memo, link, payment from wallet A, login; then wallet B, same account", async () => {
  const { codes, verify } = await freshSite();
  const account = fixedKey("user").siteKey(SITE_ID).publicKey;

  // The link the user's wallet would open for code c1 pays exactly the site's address.
  const uri = buildPaymentUri(codes.c1, memoFor(PAYMENTS[0], codes));
  assert.deepEqual(checkSinglePayee(uri), { ok: true, address: SITE_ADDRESS });

  const first = await verify("login_wallet_a");
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.accountId, account);
  assert.deepEqual(first.ok && first.siteLearned, { accountId: account, amountZat: 10_000, pool: "ironwood" });

  const second = await verify("login_wallet_b");
  assert.equal(second.ok && second.accountId, account, "a different wallet address lands in the same account");

  const orchard = await verify("login_orchard_wallet_a");
  assert.equal(orchard.ok && orchard.accountId, account, "Orchard (v5) payments work too");

  const other = await verify("second_account_same_wallet");
  assert.equal(other.ok, true);
  assert.notEqual(other.ok && other.accountId, account, "a different login key is a different account, even from the same wallet");
});

const refused: [string, string, number?][] = [
  ["copied_memo_other_wallet", "code_already_used"],
  ["memo_for_other_site", "wrong_site"],
  ["paid_to_other_site", "nothing_for_this_site"],
  ["below_minimum", "amount_too_low"],
  ["late_payment", "code_expired", T0 + 601],
];

test("replay and wrong-site cases fail with named reasons", async () => {
  const { verify } = await freshSite();
  assert.equal((await verify("login_wallet_a")).ok, true);
  const again = await verify("login_wallet_a");
  assert.equal(!again.ok && again.reason, "transaction_already_used");
  for (const [label, reason, now] of refused) {
    const r = await verify(label, now);
    assert.equal(r.ok ? "ok" : r.reason, reason, label);
  }
});

test("a copied memo paid from someone else's wallet gets nobody in without the user's proof", async () => {
  // The attacker saw the link and paid the same memo from their own wallet. They cannot make the proof.
  const { verify, store } = await freshSite();
  const attackerProof = buildLoginProof(fixedKey("attacker"), (await siteCodes()).codes.c1);
  const stolen = await verifyLoginPayment(tx("copied_memo_other_wallet"), site.ufvk, store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, now: NOW, proof: attackerProof });
  assert.equal(!stolen.ok && stolen.reason, "bad_proof");
  const none = await verifyLoginPayment(tx("copied_memo_other_wallet"), site.ufvk, store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, now: NOW });
  assert.equal(!none.ok && none.reason, "bad_proof");
  // The refusals burned nothing: the real user's own payment of the same code still logs in.
  assert.equal((await verify("login_wallet_a")).ok, true);
});

test("the other site's own viewing key refuses a memo made for shop.example", async () => {
  const store = new MemoryChallengeStore();
  const r = await verifyLoginPayment(tx("paid_to_other_site"), v.parties["site other.example"].ufvk, store, { siteId: "other.example", now: NOW });
  assert.equal(!r.ok && r.reason, "wrong_site");
});

test("a stranger's viewing key sees no login at all", async () => {
  const r = await verifyLoginPayment(tx("login_wallet_a"), v.parties["someone else"].ufvk, new MemoryChallengeStore(), { siteId: SITE_ID, now: NOW });
  assert.equal(!r.ok && r.reason, "nothing_for_this_site");
});

test("codes are tied to this exact plan (sanity)", async () => {
  const { codes } = await siteCodes();
  for (const c of Object.values<Challenge>(codes)) assert.equal(c.expiresAt, T0 + 600);
});
