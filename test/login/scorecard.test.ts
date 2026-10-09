// The login scorecard: it passes this repo's login, fails a weak one, and each of its six checks can
// fail on its own (shown by breaking the repo's login in one way at a time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScorecard, scorecardText, type LoginUnderTest } from "../../src/login/index.ts";
import { imaniUnderTest, weakUnderTest } from "../../tools/scorecard-adapters.ts";

const status = (card: Awaited<ReturnType<typeof runScorecard>>) => Object.fromEntries(card.lines.map((l) => [l.id, l.status]));
const ALL = ["one-time-code", "expiry", "rotation", "link-secrets", "sender-hidden", "copycat-refused"];

test("this repo's login passes all six checks", async () => {
  const card = await runScorecard(imaniUnderTest());
  assert.deepEqual(card.lines.map((l) => l.id), ALL);
  assert.equal(card.passed, 6);
  assert.equal(card.failed, 0);
  assert.match(scorecardText(card), /RESULT: PASS \(6 passed, 0 failed\)/);
});

test("a deliberately weak login fails five of six, and only its working expiry passes", async () => {
  const card = await runScorecard(weakUnderTest());
  assert.deepEqual(status(card), {
    "one-time-code": "FAIL",
    expiry: "PASS",
    rotation: "FAIL",
    "link-secrets": "FAIL",
    "sender-hidden": "FAIL",
    "copycat-refused": "FAIL",
  });
  assert.match(scorecardText(card), /RESULT: FAIL \(1 passed, 5 failed\)/);
});

/** This repo's login with one behaviour broken. Only the named check should turn red. */
async function broken(id: string, change: (t: LoginUnderTest) => LoginUnderTest, alsoFails: string[] = []) {
  const card = await runScorecard(change(imaniUnderTest()));
  const s = status(card);
  assert.equal(s[id], "FAIL", `${id} should fail`);
  for (const other of ALL.filter((x) => x !== id && !alsoFails.includes(x))) assert.equal(s[other], "PASS", `${other} should still pass when only ${id} is broken`);
}

test("check 1 fails when a payment can log in twice", () =>
  broken("one-time-code", (t) => {
    const done = new Map<unknown, Awaited<ReturnType<LoginUnderTest["submit"]>>>();
    return { ...t, submit: async (h, p, by) => (done.get(p) && by === "owner" ? done.get(p)! : (done.set(p, await t.submit(h, p, by)), done.get(p)!)) };
  }, ["copycat-refused"])); // replaying the first answer also hands the copycat's answer to the owner

test("check 2 fails when the clock never expires a code", () => broken("expiry", (t) => ({ ...t, advance: () => {} })));

test("check 3 fails when the account follows the paying wallet", () =>
  broken("rotation", (t) => ({
    ...t,
    pay: async (h, l, w) => {
      const r = await t.pay(h, l, w);
      return { payment: { inner: r.payment, w }, walletAddress: r.walletAddress };
    },
    submit: async (h, p, by) => {
      const r = await t.submit(h, (p as { inner: unknown }).inner, by);
      return r.ok ? { ...r, account: `${r.account}@${(p as { w: string }).w}` } : r;
    },
  })));

test("check 4 fails when a secret rides in the payment link", () =>
  broken("link-secrets", (t) => ({
    ...t,
    begin: async (u) => {
      const r = await t.begin(u);
      return { handle: r.handle, link: `${r.link}&k=${t.secrets(r.handle)[0]}` };
    },
  })));

test("check 4 fails when the link pays a second, hidden address", async () => {
  const card = await runScorecard({
    ...imaniUnderTest(),
    begin: async (u) => {
      const r = await imaniUnderTest().begin(u);
      return { handle: r.handle, link: `${r.link}&address.1=utest1hidden&amount.1=1` };
    },
  });
  assert.equal(status(card)["link-secrets"], "FAIL");
  assert.match(card.lines.find((l) => l.id === "link-secrets")!.detail, /more than one address/);
});

test("check 5 fails when the paying address is stored, and is skipped when the login cannot show what it stored", async () => {
  await broken("sender-hidden", (t) => {
    const seen: string[] = [];
    return {
      ...t,
      pay: async (h, l, w) => {
        const r = await t.pay(h, l, w);
        seen.push(r.walletAddress);
        return r;
      },
      stored: async () => (await t.stored!()) + seen.join(","),
    };
  });
  const { stored: _drop, ...noStore } = imaniUnderTest();
  const card = await runScorecard(noStore);
  assert.equal(status(card)["sender-hidden"], "SKIPPED");
  assert.equal(card.skipped, 1);
  assert.match(scorecardText(card), /1 skipped/);
});

test("check 6 fails when a copycat is let in, and when refusing the copycat locks the real user out", async () => {
  await broken("copycat-refused", (t) => ({ ...t, submit: (h, p) => t.submit(h, p, "owner") }));
  const card = await runScorecard({
    ...imaniUnderTest(),
    submit: async (h, p, by) => {
      const r = await imaniUnderTest().submit(h, p, by);
      return by === "copycat" ? { ...r, ok: false } : { ok: false, raw: "{}" };
    },
  });
  assert.equal(status(card)["copycat-refused"], "FAIL");
});

test("a login that throws fails the check instead of crashing the card or passing", async () => {
  const card = await runScorecard({ ...imaniUnderTest(), advance: () => { throw new Error("secret detail that must not be shown"); } });
  assert.equal(status(card).expiry, "FAIL");
  assert.ok(!scorecardText(card).includes("secret detail"));
});
