// Leak scan. Runs the whole login (good and bad paths, both adapters) while recording every
// log line, error message, web response, cookie, session value and serialised object, then
// asserts that none of them holds the user's login key, the login memo, or the site's viewing key.
//
// One deliberate exception, checked separately: the zcash: payment link carries the login memo,
// because that is how the wallet receives it. It is built on the user's side and handed to the
// wallet; it is never a web address and never reaches the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  AccountKey,
  buildLoginMemo,
  buildPaymentUri,
  createChallenge,
  exportAccountKey,
  importAccountKey,
  MemoryChallengeStore,
  SignedSessions,
  MemorySessions,
  zcashCredentials,
  zcashLogin,
  verifyLoginPayment,
  LoginKit,
} from "../../src/login/index.ts";
import { b64urlEncode } from "../../src/login/encoding.ts";
import { T0, fixedKey } from "./helpers.ts";
import { PAYMENTS, SITE_ADDRESS, SITE_ID, memoFor, siteCodes } from "./offline-plan.ts";
import { P, SECRET, UFVK, fakeReq, makeKit, run, v } from "./fakes.ts";

const userKey = fixedKey("user");
const exported = exportAccountKey(userKey);
const seedB64 = exported.split(":")[1];
const seedHex = Buffer.from(seedB64, "base64url").toString("hex");

test("no login key, memo or viewing key in any log, error, response, cookie, session or URL", async () => {
  const seen: string[] = [];
  const urls: string[] = [];
  const zcashUris: string[] = [];

  // Record everything written to the console or the process streams during the run.
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void seen.push(a.map((x) => inspect(x)).join(" "));
  process.stdout.write = ((c: any, ...r: any[]) => (seen.push(String(c)), out(c, ...r))) as any;
  process.stderr.write = ((c: any, ...r: any[]) => (seen.push(String(c)), err(c, ...r))) as any;

  const memos: string[] = [];
  try {
    const { codes } = await siteCodes();
    for (const p of PAYMENTS) memos.push(memoFor(p, codes));
    const memo = memos[0];
    const uri = buildPaymentUri(codes.c1, memo);
    zcashUris.push(uri);

    // Objects people tend to print or store.
    for (const o of [userKey, userKey.siteKey(SITE_ID), new SignedSessions(SECRET), await makeKit()]) {
      seen.push(JSON.stringify(o), inspect(o), String(o), `${o}`);
    }

    // Thrown errors on bad input.
    const throwers: (() => unknown)[] = [
      () => importAccountKey(exported.slice(0, -3)),
      () => importAccountKey(exported + "!"),
      () => importAccountKey(memo),
      () => buildLoginMemo(userKey, { ...codes.c1, siteId: "BAD SITE " + UFVK }),
      () => buildPaymentUri({ siteAddress: SITE_ADDRESS, network: "test", minZat: 1 }, "x " + UFVK),
      () => buildPaymentUri({ siteAddress: SITE_ADDRESS, network: "test", minZat: 1 }, memo + "x".repeat(400)),
      () => new LoginKit({ siteId: SITE_ID, siteAddress: "u1" + "q".repeat(90), viewingKey: UFVK }),
      () => new LoginKit({ siteId: SITE_ID, siteAddress: SITE_ADDRESS, viewingKey: exported }),
    ];
    for (const t of throwers) {
      try {
        t();
      } catch (e) {
        seen.push((e as Error).message, String((e as Error).stack));
      }
    }
    for (const p of [createChallenge(new MemoryChallengeStore(), { siteId: SITE_ID, siteAddress: UFVK, network: "test" })]) {
      await p.catch((e: Error) => seen.push(e.message, String(e.stack)));
    }

    // Every verify result, good and bad, with the log hook on.
    const store = new MemoryChallengeStore();
    await siteCodes(store);
    const log = (e: string) => seen.push(e);
    for (const label of Object.keys(v.transactions)) {
      for (const now of [T0 + 60, T0 + 9999]) {
        const r = await verifyLoginPayment(v.transactions[label].txHex, UFVK, store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, now, log, proof: P[label] });
        seen.push(JSON.stringify(r), inspect(r));
      }
    }
    seen.push(JSON.stringify(await verifyLoginPayment("00ff", UFVK, store, { siteId: SITE_ID, log })));

    // Both adapters, including their cookies and session values.
    for (const sessions of [new SignedSessions(SECRET), new MemorySessions()]) {
      const mw = zcashLogin({ kit: await makeKit(log), sessions });
      const reqs = [
        fakeReq("GET", "/zcash-login/challenge"),
        fakeReq("POST", "/zcash-login/verify", { body: { txHex: v.transactions.login_wallet_a.txHex, proof: P.login_wallet_a } }),
        fakeReq("POST", "/zcash-login/verify", { body: { txHex: v.transactions.login_wallet_a.txHex, proof: P.login_wallet_a } }),
        fakeReq("POST", "/zcash-login/verify", { body: { txHex: v.transactions.memo_for_other_site.txHex, proof: P.memo_for_other_site } }),
        fakeReq("POST", "/zcash-login/verify", { raw: '{"txHex": "' + memo + '"}' }),
        fakeReq("POST", "/zcash-login/verify", { raw: "{broken " + UFVK }),
      ];
      for (const req of reqs) {
        urls.push(req.url);
        const { res } = await run(mw, req);
        seen.push(res.body, JSON.stringify(res.headers));
        const cookie: string | undefined = res.headers["set-cookie"];
        if (cookie) {
          const value = cookie.split(";")[0].split("=")[1];
          seen.push(value, JSON.stringify(await sessions.read(value)));
          for (const part of value.split(".")) {
            try {
              seen.push(Buffer.from(part, "base64url").toString("utf8"));
            } catch {}
          }
        }
      }
    }
    const provider = zcashCredentials(await makeKit(log));
    seen.push(JSON.stringify(await provider.authorize({ txHex: v.transactions.login_wallet_b.txHex, proof: P.login_wallet_b })));
    seen.push(JSON.stringify(provider));
  } finally {
    Object.assign(console, orig);
    process.stdout.write = out as any;
    process.stderr.write = err as any;
  }

  const secrets: [string, string][] = [
    ["login key backup", exported],
    ["login key (base64url)", seedB64],
    ["login key (hex)", seedHex],
    ["site viewing key", UFVK],
    ["site viewing key (first 40 chars)", UFVK.slice(0, 40)],
  ];
  for (const m of memos) {
    secrets.push(["login memo", m], ["memo signature", m.split("sig:")[1]], ["memo as base64url", b64urlEncode(Buffer.from(m))]);
  }

  const haystack = [...seen, ...urls];
  assert.ok(seen.length > 60, `recorded ${seen.length} items`);
  for (const [name, secret] of secrets) {
    const hits = haystack.filter((h) => h.includes(secret));
    assert.equal(hits.length, 0, `${name} found in ${hits.length} place(s): ${hits[0]?.slice(0, 80)}`);
  }
  for (const u of urls) assert.ok(!u.includes("?"), "no query strings at all in the adapter's web addresses");

  // The zcash: link: carries the memo by design, never the login key or viewing key.
  for (const u of zcashUris) {
    for (const [name, secret] of secrets.filter(([n]) => !n.startsWith("login memo") && !n.startsWith("memo"))) {
      assert.ok(!u.includes(secret), `${name} in payment link`);
    }
  }
});

test("a fresh random login key never shows up in its own memo, link or exported public data", async () => {
  const key = AccountKey.generate();
  const backup = exportAccountKey(key);
  const store = new MemoryChallengeStore();
  const c = await createChallenge(store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, network: "test" });
  const memo = buildLoginMemo(key, c);
  const uri = buildPaymentUri(c, memo);
  const seed = backup.split(":")[1];
  for (const text of [memo, uri, JSON.stringify(key), inspect(key), JSON.stringify(key.siteKey(SITE_ID))]) {
    assert.ok(!text.includes(seed));
    assert.ok(!text.includes(Buffer.from(seed, "base64url").toString("hex")));
  }
});
