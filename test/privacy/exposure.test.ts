// The two extra privacy checks of `imani linking`: what memos carry, and what block timing gives away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { bidMemoNote, refundMemoNote, timingFindings } from "../../src/privacy/exposure.ts";
import { run } from "../../src/cli.ts";

const path = (p: string) => fileURLToPath(new URL(`../../examples/${p}/disclosure.json`, import.meta.url));
const U1 = "u1" + "q".repeat(60);
const T1 = "t1" + "Kd".repeat(14);

test("a bid memo with only a word, or a word and a shielded address, has no note", () => {
  assert.equal(bidMemoNote("m3x8"), null);
  assert.equal(bidMemoNote(`m3x8:${U1}`), null);
  assert.equal(bidMemoNote("m3x8:utest1abc123def456"), null);
});

test("a transparent address in a bid memo is noted", () => {
  assert.equal(bidMemoNote(`m3x8:${T1}`), "transparent-address");
});

test("an email, a link or a phone number in a bid memo is noted as a contact detail", () => {
  assert.equal(bidMemoNote("m3x8:alice@example.com"), "contact-detail");
  assert.equal(bidMemoNote("m3x8 https://example.com/me"), "contact-detail");
  assert.equal(bidMemoNote("m3x8 call +234 801 234 5678"), "contact-detail");
});

test("extra words or colons in a bid memo are noted as extra text", () => {
  assert.equal(bidMemoNote("my name is Alice"), "extra-text");
  assert.equal(bidMemoNote(`m3x8:${U1}:more`), "extra-text");
  assert.equal(bidMemoNote("m3x8:notanaddress"), "extra-text");
});

test("a refund memo must be exactly the bid's transaction id", () => {
  assert.equal(refundMemoNote("a".repeat(64)), null);
  assert.equal(refundMemoNote("a".repeat(64) + " thanks!"), "extra-text");
  assert.equal(refundMemoNote("write me at bob@example.com"), "contact-detail");
});

test("refunds that follow their bids by the same delay are noted", () => {
  const t = timingFindings([{ bid: 100, refund: 130 }, { bid: 105, refund: 135 }, { bid: 111, refund: 141 }], [130, 135, 141]);
  assert.deepEqual(t.map((x) => x.kind).sort(), ["same-delay", "same-order"]);
});

test("refunds in the same order as bids, each in its own block, are noted", () => {
  const t = timingFindings([{ bid: 100, refund: 130 }, { bid: 105, refund: 140 }], [130, 140]);
  assert.deepEqual(t.map((x) => x.kind), ["same-order"]);
});

test("refunds in a mixed order with different delays have no note", () => {
  const t = timingFindings([{ bid: 100, refund: 150 }, { bid: 105, refund: 130 }, { bid: 111, refund: 140 }], [150, 130, 140]);
  assert.deepEqual(t, []);
});

test("refunds all sent in one block are marked good, not a warning", () => {
  const t = timingFindings([{ bid: 100, refund: 130 }, { bid: 105, refund: 130 }], [130, 130]);
  assert.deepEqual(t.map((x) => x.kind), ["one-refund-block"]);
});

test("a single bid has nothing to pair", () => {
  assert.deepEqual(timingFindings([{ bid: 100, refund: 130 }], [130]), []);
});

test("imani linking prints the extra checks on a real round and keeps its result line and exit code", () => {
  const r = run(["linking", path("memo-01")]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Extra checks on what the payments give away/);
  assert.match(r.stdout, /Memos read with the lot key: 8\. Notes: 0/);
  assert.match(r.stdout, /note: each bid and each refund is in a block of its own/);
  assert.match(r.stdout, /RESULT: NO LINKS OUTSIDE THE ROUND/);
});

test("the extra checks never print a viewing key or a memo's text", () => {
  const r = run(["linking", path("testnet-01")]);
  assert.doesNotMatch(r.stdout, /uviewtest1|uview1/);
  assert.doesNotMatch(r.stdout, /bid:DRY-01:/);
});
