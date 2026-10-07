import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginKit, MemorySessions, SignedSessions, zcashLogin, requireZcashLogin, zcashCredentials, zcashChallengeRoute } from "../../src/login/index.ts";
import { T0 } from "./helpers.ts";
import { SITE_ADDRESS, SITE_ID } from "./offline-plan.ts";
import { ACCOUNT, SECRET, UFVK, fakeReq, fakeRes, makeKit, run, v } from "./fakes.ts";

test("Express: challenge, verify with a real transaction, cookie, protected route, logout", async () => {
  const sessions = new SignedSessions(SECRET);
  const mw = zcashLogin({ kit: await makeKit(), sessions, secureCookie: true });

  const c = await run(mw, fakeReq("GET", "/zcash-login/challenge"));
  assert.equal(c.res.statusCode, 200);
  assert.deepEqual(Object.keys(c.json).sort(), ["expiresAt", "minZat", "network", "nonce", "siteAddress", "siteId"]);
  assert.equal(c.res.headers["cache-control"], "no-store");

  // Body already parsed by express.json()
  const ok = await run(mw, fakeReq("POST", "/zcash-login/verify", { body: { txHex: v.transactions.login_wallet_a.txHex } }));
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.json.accountId, ACCOUNT);
  const setCookie = ok.res.headers["set-cookie"];
  assert.match(setCookie, /^imani_session=s1\.[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const cookie = setCookie.split(";")[0];

  // Raw JSON body, no body parser
  const b = await run(mw, fakeReq("POST", "/zcash-login/verify", { raw: JSON.stringify({ txHex: v.transactions.login_wallet_b.txHex }) }));
  assert.equal(b.json.accountId, ACCOUNT);

  const replay = await run(mw, fakeReq("POST", "/zcash-login/verify", { body: { txHex: v.transactions.login_wallet_a.txHex } }));
  assert.equal(replay.res.statusCode, 401);
  assert.equal(replay.json.reason, "transaction_already_used");

  const page = fakeReq("GET", "/account", { cookie: `other=1; ${cookie}` });
  const through = await run(mw, page);
  assert.equal(through.nextCalled, true);
  assert.equal(page.zcashAccount, ACCOUNT);

  const anon = fakeReq("GET", "/account");
  await run(mw, anon);
  const guard = fakeRes();
  requireZcashLogin(anon, guard, () => assert.fail("should not pass"));
  assert.equal(guard.statusCode, 401);

  const forged = fakeReq("GET", "/account", { cookie: cookie.replace(/.$/, (ch: string) => (ch === "A" ? "B" : "A")) });
  await run(mw, forged);
  assert.equal(forged.zcashAccount, undefined);

  const out = await run(mw, fakeReq("POST", "/zcash-login/logout", { cookie }));
  assert.match(out.res.headers["set-cookie"], /Max-Age=0/);
});

test("Express: bad bodies get a plain 400 or 401, never a stack trace", async () => {
  const mw = zcashLogin({ kit: await makeKit(), sessions: new MemorySessions() });
  const bad = await run(mw, fakeReq("POST", "/zcash-login/verify", { raw: "{not json" }));
  assert.equal(bad.res.statusCode, 400);
  assert.deepEqual(bad.json, { reason: "bad_request", message: "The login request could not be handled." });
  const empty = await run(mw, fakeReq("POST", "/zcash-login/verify", { body: {} }));
  assert.equal(empty.res.statusCode, 401);
  assert.equal(empty.json.reason, "unreadable_transaction");
  const big = zcashLogin({ kit: await makeKit(), sessions: new MemorySessions(), bodyLimit: 10 });
  assert.equal((await run(big, fakeReq("POST", "/zcash-login/verify", { raw: "x".repeat(50) }))).res.statusCode, 400);
});

test("Express: plain session ids work and logout ends them", async () => {
  const sessions = new MemorySessions();
  const mw = zcashLogin({ kit: await makeKit(), sessions, basePath: "/auth/zec/", secureCookie: false, cookieName: "sid" });
  const ok = await run(mw, fakeReq("POST", "/auth/zec/verify", { body: { txHex: v.transactions.login_wallet_a.txHex } }));
  const cookie = ok.res.headers["set-cookie"].split(";")[0];
  assert.ok(!ok.res.headers["set-cookie"].includes("Secure"));
  const id = cookie.split("=")[1];
  assert.equal(sessions.read(id)?.accountId, ACCOUNT);
  await run(mw, fakeReq("POST", "/auth/zec/logout", { cookie }));
  assert.equal(sessions.read(id), undefined);
});

test("signed sessions expire and refuse tampering", () => {
  const s = new SignedSessions(SECRET, 100);
  const value = s.issue(ACCOUNT, T0);
  assert.equal(s.read(value, T0 + 50)?.accountId, ACCOUNT);
  assert.equal(s.read(value, T0 + 101), undefined);
  assert.equal(new SignedSessions(SECRET + "x").read(value, T0), undefined);
  assert.throws(() => new SignedSessions("short"));
});

test("Auth.js: credentials provider config logs in with a real transaction and refuses a replay", async () => {
  const provider = zcashCredentials(await makeKit());
  assert.equal(provider.id, "zcash");
  assert.deepEqual(Object.keys(provider.credentials), ["txHex"]);
  assert.deepEqual(await provider.authorize({ txHex: v.transactions.login_wallet_a.txHex }), { id: ACCOUNT });
  assert.equal(await provider.authorize({ txHex: v.transactions.login_wallet_a.txHex }), null);
  assert.deepEqual(await provider.authorize({ txHex: v.transactions.login_wallet_b.txHex }), { id: ACCOUNT });
  assert.equal(await provider.authorize(undefined), null);
  assert.equal(await provider.authorize({ txHex: 42 }), null);
});

test("Auth.js: challenge route returns a fresh public code", async () => {
  const GET = zcashChallengeRoute(await makeKit());
  const res = await GET();
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.siteId, SITE_ID);
  assert.equal(body.siteAddress, SITE_ADDRESS);
  assert.equal(body.network, "test");
});

test("the kit refuses a spending key and a mismatched network", () => {
  assert.throws(() => new LoginKit({ siteId: SITE_ID, siteAddress: SITE_ADDRESS, viewingKey: "secret-extended-key-test1abc" }));
  assert.throws(() => new LoginKit({ siteId: SITE_ID, siteAddress: "u1" + "q".repeat(100), viewingKey: UFVK }));
});
