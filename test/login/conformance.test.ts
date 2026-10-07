// Login conformance test. Another implementation can run the same checks by reading
// docs/login/vectors.json and comparing its own results; nothing here depends on imani internals
// except the four functions under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AccountKey, buildLoginMemo, buildPaymentUri, checkLoginMemo, checkSinglePayee, signedText, buildLoginProof, proofText, verifySignature } from "../../src/login/index.ts";
import { VECTORS_URL, makeVectors } from "./conformance-vectors.ts";

const v = JSON.parse(readFileSync(VECTORS_URL, "utf8"));

test("vector file is up to date and generated deterministically", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(makeVectors())), v);
});

test("per-site account ids", () => {
  for (const d of v.derive) {
    assert.equal(AccountKey.fromSeed(Buffer.from(d.accountSeedHex, "hex")).siteKey(d.siteId).publicKey, d.accountId, d.siteId);
  }
});

test("memo and payment link building", () => {
  for (const b of v.build) {
    const key = AccountKey.fromSeed(Buffer.from(b.accountSeedHex, "hex"));
    const memo = buildLoginMemo(key, b.challenge);
    assert.equal(memo, b.memo);
    assert.equal(Buffer.byteLength(memo), b.memoBytes);
    assert.ok(b.memoBytes <= 512);
    assert.equal(memo.split("\nsig:")[0], b.signedText);
    assert.equal(signedText({ ...b.challenge, accountId: key.siteKey(b.challenge.siteId).publicKey }), b.signedText);
    assert.equal(buildPaymentUri(b.challenge, memo), b.paymentUri);
  }
});

test("memo checks: every valid case passes and every invalid case fails with the named reason", () => {
  assert.ok(v.memoCheck.length >= 20);
  for (const c of v.memoCheck) {
    const r = checkLoginMemo(c.memo, v.context);
    const got = r.ok ? { ok: true, accountId: r.memo.accountId } : { ok: false, reason: r.reason };
    assert.deepEqual(got, c.expect, c.name);
    assert.equal(c.expect.ok, c.name.startsWith("valid"), `${c.name} should ${c.name.startsWith("valid") ? "pass" : "fail"}`);
  }
});

test("payment links pay exactly one address", () => {
  for (const p of v.singlePayee) assert.equal(checkSinglePayee(p.uri).ok, p.singlePayee, p.uri);
});

test("login proofs: built byte for byte, and only the account key's proof for this site and code passes", () => {
  const p = v.proof;
  const key = AccountKey.fromSeed(Buffer.from(p.accountSeedHex, "hex"));
  assert.equal(key.siteKey(p.siteId).publicKey, p.accountId);
  assert.equal(proofText(p.siteId, p.nonce), p.text);
  assert.equal(buildLoginProof(key, { siteId: p.siteId, nonce: p.nonce }), p.cases[0].proof);
  assert.deepEqual(p.cases.map((c: any) => c.valid), [true, false, false, false, false, false]);
  for (const c of p.cases) assert.equal(verifySignature(p.accountId, p.text, c.proof), c.valid, c.name);
});
