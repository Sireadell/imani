// Shop auction demo: routes, sign-in in simulated mode end to end, bid, publish, check,
// tampered copies, live mode failing closed, and a scan for keys in every response, log and URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as browser from "../../demo/public/imani-login.js";
import { AccountKey, buildLoginMemo, buildLoginProof, buildPaymentUri, exportAccountKey, importAccountKey } from "../../src/login/index.ts";
import { ConfigError, ROOT, loadConfig, simLoginParty, simLot } from "../../demo/config.ts";
import { parsePaymentLink } from "../../demo/chain.ts";
import { numberChanges } from "../../demo/lot.ts";
import { startDemo, type Harness } from "./harness.ts";

const LOT_UFVK: string = JSON.parse(readFileSync(join(ROOT, "examples", "round-01", "disclosure.json"), "utf8")).ufvk;
const SITE = simLoginParty();
const LOT = simLot();
const PAGES = ["/", "/signin", "/lot", "/seller", "/check", "/privacy"];

const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(`imani demo test key: ${label}`).digest());

/** Sign in through the simulated wallet exactly as the browser page does. Returns the response JSON. */
async function signIn(h: Harness, seed: Uint8Array) {
  const accountId = (await browser.siteKey(seed, "imani-shop.example")).accountId;
  const challenge = JSON.parse((await h.post("/login/challenge", { accountId })).text_);
  const { memo } = await browser.buildLoginMemo(seed, challenge);
  const link = browser.paymentLink(challenge.siteAddress, challenge.minZat, memo);
  const sent = JSON.parse((await h.post("/sim/chain/send", { uri: link })).text_);
  assert.equal(sent.ok, true, sent.message);
  const proof = await browser.buildLoginProof(seed, challenge);
  const r = await h.post("/login/verify", { txid: sent.txid, proof });
  return { ...JSON.parse(r.text_), txid: sent.txid, memo, challenge, proof };
}

test("the browser login code matches the kit byte for byte", async () => {
  assert.equal(await browser.ed25519Supported(), true);
  const seed = seedOf("match");
  const challenge = { nonce: "7K4Q-M2XD-RW8T-HC3N-P5VA", siteId: "imani-shop.example", siteAddress: SITE.address, network: "test" as const, expiresAt: 1790000600, minZat: 10_000 };
  const fromKit = buildLoginMemo(AccountKey.fromSeed(seed), challenge);
  const fromBrowser = await browser.buildLoginMemo(seed, challenge);
  assert.equal(fromBrowser.memo, fromKit);
  assert.equal(await browser.buildLoginProof(seed, challenge), buildLoginProof(AccountKey.fromSeed(seed), challenge));
  assert.equal(browser.paymentLink(challenge.siteAddress, challenge.minZat, fromBrowser.memo), buildPaymentUri(challenge, fromKit));
  const backup = browser.exportLoginKey(seed);
  assert.equal(backup, exportAccountKey(AccountKey.fromSeed(seed)));
  assert.deepEqual([...browser.importLoginKey(backup)], [...seed]);
  assert.equal(exportAccountKey(importAccountKey(backup)), backup);
  assert.throws(() => browser.importLoginKey("hello"), /not an imani login key backup/);
  assert.equal(browser.formatZec(2_000_000), "0.02");
  assert.equal(browser.parseZec("0.02"), 2_000_000);
  assert.equal(browser.parseZec("abc"), null);
});

test("every page shows the SIMULATED banner, sends privacy headers and loads nothing from elsewhere", async () => {
  const h = await startDemo();
  try {
    for (const p of PAGES) {
      const r = await h.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.text_, /<strong>SIMULATED<\/strong>/, p);
      assert.match(r.text_, /Simulated payments/, p);
      assert.match(r.text_, /Servers contacted: none/, p);
      assert.doesNotMatch(r.text_, /(src|href|action)="(https?:)?\/\//i, `${p} links to another site`);
      assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'; script-src 'self'/);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    const home = (await h.get("/")).text_;
    assert.match(home, /What this site learns and what the servers learn/);
    assert.match(home, /Honest limits/);
    assert.match(home, /The seller can see bids as they arrive/);
    assert.match(home, /The check works only if the seller shares the lot key/);
    assert.match(home, /Signing in proves two things only/);
    assert.equal((await h.get("/nope")).status, 404);
    assert.equal((await h.get("/static/../config.ts")).status, 404);
    assert.equal((await h.get("/lot/files/disclosure.json")).status, 404, "nothing is published before the seller publishes");
  } finally {
    await h.close();
  }
});

test("sign-in in simulated mode, end to end: same account from a new address, no replays", async () => {
  const h = await startDemo();
  try {
    const seed = seedOf("user");
    const first = await signIn(h, seed);
    assert.equal(first.ok, true, first.message);
    assert.match(h.cookie, /^imani_session=s1\./);
    assert.deepEqual(Object.keys(first.learned).sort(), ["accountId", "amountZat", "pool"]);
    assert.equal(first.learned.amountZat, 10_000);
    const lot = (await h.get("/lot")).text_;
    assert.match(lot, new RegExp(`Account ${first.accountId.slice(0, 6).replace(/[-_]/g, "\\$&")}`));
    assert.match(lot, /id="make-bid"/);

    // Same key, new code, "new wallet address": the shop never sees the address, the account stays.
    const second = await signIn(h, seed);
    assert.equal(second.ok, true);
    assert.equal(second.accountId, first.accountId);

    // A different key is a different account.
    const other = await signIn(h, seedOf("someone else"));
    assert.notEqual(other.accountId, first.accountId);

    // The same payment cannot sign in twice.
    const replay = JSON.parse((await h.post("/login/verify", { txid: first.txid, proof: first.proof })).text_);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "transaction_already_used");

    // The same code cannot be paid twice, even from a new payment.
    const again = JSON.parse((await h.post("/sim/chain/send", { uri: browser.paymentLink(SITE.address, 10_000, first.memo) })).text_);
    const reused = JSON.parse((await h.post("/login/verify", { txid: again.txid, proof: first.proof })).text_);
    assert.equal(reused.reason, "code_already_used");

    // Front-running: someone who saw the link pays the same memo and posts it without the user's proof.
    const accountId = (await browser.siteKey(seedOf("victim"), "imani-shop.example")).accountId;
    const vc = JSON.parse((await h.post("/login/challenge", { accountId })).text_);
    const vmemo = (await browser.buildLoginMemo(seedOf("victim"), vc)).memo;
    const stolen = JSON.parse((await h.post("/sim/chain/send", { uri: browser.paymentLink(vc.siteAddress, vc.minZat, vmemo) })).text_);
    const attack = await h.post("/login/verify", { txid: stolen.txid, proof: await browser.buildLoginProof(seedOf("attacker"), vc) });
    assert.equal(JSON.parse(attack.text_).reason, "bad_proof");
    assert.equal(attack.headers.get("set-cookie"), null, "no session for the attacker");
    const mine = JSON.parse((await h.post("/login/verify", { txid: stolen.txid, proof: await browser.buildLoginProof(seedOf("victim"), vc) })).text_);
    assert.equal(mine.ok, true, "the same payment still signs the real user in");

    // Junk is refused with a plain message and no sign-in.
    const junk = JSON.parse((await h.post("/login/verify", { txid: "nope" })).text_);
    assert.equal(junk.ok, false);
    assert.match(junk.message, /You are not signed in/);

    // A link with a hidden second payee is refused by the pretend wallet.
    const two = await h.post("/sim/chain/send", { uri: `zcash:${SITE.address}?amount=0.0001&address.1=${LOT.address}&amount.1=1` });
    assert.equal(two.status, 400);
    assert.match(two.text_, /more than one address/);

    const out = await h.post("/logout", {});
    assert.equal(out.status, 200);
    assert.equal(h.cookie, "");
    assert.doesNotMatch((await h.get("/lot")).text_, /id="make-bid"/);
  } finally {
    await h.close();
  }
});

test("bid, close, publish, check PASS, and my bid is in the published result", async () => {
  const h = await startDemo();
  try {
    assert.match((await h.get("/lot")).text_, /Sign in to bid/);
    await signIn(h, seedOf("bidder"));
    const want = LOT.simulated.yourBid;
    // The bid memo carries the bidder's own refund address, and the lot page asks for it.
    const refundAddr = want.memo.split(":")[3];
    assert.ok(refundAddr && refundAddr.startsWith("utest1"));
    const lotPage = (await h.get("/lot")).text_;
    assert.match(lotPage, /Your refund address/);
    assert.ok(lotPage.includes(refundAddr));
    const wrong = await h.post("/sim/chain/send", { uri: browser.paymentLink(LOT.address, 5_000_000, want.memo) });
    assert.equal(wrong.status, 400);
    const bid = JSON.parse((await h.post("/sim/chain/send", { uri: browser.paymentLink(LOT.address, want.amountZat, want.memo) })).text_);
    assert.equal(bid.txid, want.txid);

    let seller = (await h.get("/seller")).text_;
    assert.match(seller, /your bid/);
    assert.match(seller, /The seller holds the lot key from the start/);
    assert.match(seller, /Publish the result and the lot key<\/button>/);
    assert.match(seller, /disabled>Publish/);
    assert.equal((await h.post("/seller/publish", {}, false)).status, 400, "cannot publish before the close");

    const clock = await h.post("/sim/clock", { back: "/seller" }, false);
    assert.equal(clock.status, 303);
    seller = (await h.get("/seller")).text_;
    assert.match(seller, /Late, returned in full/);
    const late = await h.post("/sim/chain/send", { uri: browser.paymentLink(LOT.address, want.amountZat, want.memo) });
    assert.match(late.text_, /The lot has closed/);

    assert.equal((await h.post("/seller/publish", {}, false)).status, 303);
    seller = (await h.get("/seller")).text_;
    assert.match(seller, /Lot key fingerprint/);

    const result = JSON.parse((await h.get("/lot/files/result.json")).text_);
    assert.ok(result.bids.some((b: { txid: string }) => b.txid === want.txid), "my bid is counted in the published result");
    assert.ok(result.winners.includes(want.txid));

    const check = await h.post("/check", { copy: "published" }, false);
    assert.equal(check.status, 200);
    assert.match(check.text_, /<span class="big">PASS<\/span>/);
    assert.match(check.text_, /All \d+ checks passed/);
    assert.match(check.text_, /Was my bid counted\?/);

    const verdict = JSON.parse((await h.get("/check/verdict.json?copy=published")).text_);
    assert.equal(verdict.result, "PASS");
    assert.equal(verdict.keyLevel, "PASS");
    const report = await h.get("/check/report.html?copy=published");
    assert.match(report.text_, /PASS: all/);

    // Restart puts everything back.
    assert.equal((await h.post("/sim/reset", {}, false)).status, 303);
    assert.equal((await h.get("/lot/files/result.json")).status, 404);
  } finally {
    await h.close();
  }
});

test("each tampered copy fails with its named reason", async () => {
  const h = await startDemo();
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, "examples", "broken", "manifest.json"), "utf8"));
    const page = (await h.get("/check")).text_;
    assert.match(page, /Try a tampered copy/);
    for (const c of manifest.copies) {
      const r = await h.post("/check", { copy: c.name }, false);
      assert.equal(r.status, 200, c.name);
      assert.match(r.text_, /<span class="big">FAIL<\/span>/, c.name);
      assert.ok(r.text_.includes(`<code>${c.expectedFailingCheck}</code>`), `${c.name} names ${c.expectedFailingCheck}`);
      const v = JSON.parse((await h.get(`/check/verdict.json?copy=${c.name}`)).text_);
      assert.ok(v.failed.includes(c.expectedFailingCheck), c.name);
    }
    const short = (await h.post("/check", { copy: "02-wrong-bid-amount" }, false)).text_;
    assert.match(short, /bid 1 amount \(zatoshis\): 3,000,000 became 2,900,000/);
    assert.equal((await h.post("/check", { copy: "../round-01" }, false)).status, 400);
  } finally {
    await h.close();
  }
});

test("no key ever appears in a page, URL, cookie or log; the lot key leaves only inside the published disclosure file", async () => {
  const h = await startDemo();
  const seed = seedOf("leak");
  const backup = browser.exportLoginKey(seed);
  try {
    const s1 = await signIn(h, seed);
    await signIn(h, seed);
    await h.post("/login/verify", { txid: s1.txid, proof: s1.proof });
    await h.post("/sim/chain/send", { uri: browser.paymentLink(LOT.address, LOT.simulated.yourBid.amountZat, LOT.simulated.yourBid.memo) });
    for (const p of PAGES) await h.get(p);
    await h.post("/sim/clock", { back: "/lot" }, false);
    await h.post("/seller/publish", {}, false);
    for (const p of PAGES) await h.get(p);
    await h.post("/check", { copy: "published" }, false);
    await h.post("/check", { copy: "04-short-refund" }, false);
    await h.get("/check/report.html?copy=published");
    await h.get("/check/verdict.json?copy=published");
    await h.get("/lot/files/result.json");
    await h.get("/lot/files/disclosure.json");
    for (const f of readdirSync(join(ROOT, "demo", "public"))) await h.get(`/static/${f}`);

    const secrets: [string, string][] = [
      ["lot key", LOT_UFVK],
      ["site viewing key", SITE.ufvk],
      ["login key backup", backup],
      ["login key bytes", Buffer.from(seed).toString("hex")],
      ["login key base64", browser.b64url(seed)],
    ];
    for (const s of h.seen) {
      for (const [name, value] of secrets) {
        assert.ok(!s.url.includes(value), `${name} in URL ${s.url}`);
        assert.ok(!s.headers.includes(value), `${name} in headers of ${s.url}`);
        const allowed = name === "lot key" && s.url.endsWith("/lot/files/disclosure.json");
        if (!allowed) assert.ok(!s.body.includes(value), `${name} in body of ${s.method} ${s.url}`);
      }
    }
    const disclosure = h.seen.find((s) => s.url.endsWith("/lot/files/disclosure.json"))!;
    assert.ok(disclosure.body.includes(LOT_UFVK), "the published disclosure file carries the lot key");
    assert.match(disclosure.headers, /attachment/);

    const logText = h.logs.join("\n");
    for (const [name, value] of [...secrets, ["login memo", s1.memo], ["memo tag", "imani-login:1"], ["bid memo", LOT.simulated.yourBid.memo]] as [string, string][]) {
      assert.ok(!logText.includes(value), `${name} in the log`);
    }
    assert.ok(!/uview|utest1|u1[a-z0-9]{20}/.test(logText), "nothing shaped like a key or address in the log");
    assert.ok(h.logs.some((l) => l === "login: login_ok"));

    // The browser code never touches storage, cookies or other origins.
    for (const f of readdirSync(join(ROOT, "demo", "public")).filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(join(ROOT, "demo", "public", f), "utf8");
      assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, f);
      assert.doesNotMatch(src, /https?:\/\//, f);
    }
  } finally {
    await h.close();
  }
});

test("pretend wallet reads ZIP 321 links and the number diff is plain", () => {
  const p = parsePaymentLink(browser.paymentLink(LOT.address, 2_000_000, "bid:LOT-01:m3x8"));
  assert.deepEqual(p, { to: LOT.address, amountZat: 2_000_000, memo: "bid:LOT-01:m3x8" });
  assert.throws(() => parsePaymentLink(`zcash:${LOT.address}?amount=0.1&amount=0.2`), /appears twice/);
  assert.throws(() => parsePaymentLink(`zcash:${LOT.address}?amount=0.1&req-x=1`), /unknown required parameter/);
  assert.deepEqual(numberChanges({ a: [1, 2], b: 3 }, { a: [1, 5], b: 3 }), ["a[2]: 2 became 5"]);
});

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("live mode refuses to start without its settings, and never echoes them", () => {
  assert.throws(() => loadConfig({ argv: ["--live"], env: {} }), (e: Error) => {
    assert.ok(e instanceof ConfigError);
    for (const name of ["IMANI_LOGIN_ADDRESS", "IMANI_LOGIN_UFVK", "IMANI_SESSION_SECRET"]) assert.match(e.message, new RegExp(name));
    assert.match(e.message, /Nothing was contacted/);
    return true;
  });
  const env = { IMANI_LOGIN_ADDRESS: SITE.address, IMANI_LOGIN_UFVK: "secret-extended-key-test1abc", IMANI_SESSION_SECRET: "x".repeat(40) };
  assert.throws(() => loadConfig({ argv: ["--live"], env }), (e: Error) => !e.message.includes("secret-extended-key-test1abc") && /read-only/.test(e.message));
  assert.throws(() => loadConfig({ argv: ["--live"], env: { ...env, IMANI_LOGIN_UFVK: SITE.ufvk, IMANI_SESSION_SECRET: "short" } }), /at least 32/);
});

test("live mode runs the same sign-in path and fails closed when no server answers", async () => {
  const port = await closedPort();
  const server = `http://127.0.0.1:${port}`;
  const lotDir = mkdtempSync(join(tmpdir(), "imani-live-lot-"));
  writeFileSync(join(lotDir, "lot.json"), JSON.stringify({ lotId: "LOT-01", title: "Test lot", address: LOT.address, network: "test", closeHeight: LOT.closeHeight, itemCount: 2, reserveZat: LOT.reserveZat }));
  const h = await startDemo({
    argv: ["--live"],
    env: { IMANI_LOGIN_ADDRESS: SITE.address, IMANI_LOGIN_UFVK: SITE.ufvk, IMANI_SESSION_SECRET: "s".repeat(40), IMANI_SITE_ID: "shop.example", IMANI_SERVERS: server, IMANI_LOT_DIR: lotDir },
  });
  try {
    for (const p of PAGES) {
      const r = await h.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.text_, /<strong>LIVE<\/strong>/, p);
      assert.doesNotMatch(r.text_, /SIMULATED/, p);
    }
    assert.equal((await h.post("/sim/chain/send", { uri: "zcash:x" })).status, 404, "no pretend wallet in live mode");
    assert.equal((await h.post("/sim/clock", { back: "/lot" }, false)).status, 404);

    const c = JSON.parse((await h.get("/login/challenge")).text_);
    assert.equal(c.siteId, "shop.example");
    const r = JSON.parse((await h.post("/login/verify", { txid: "ab".repeat(32) })).text_);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "payment_not_read");
    assert.match(r.message, /could not be read from two independent Zcash servers/);
    assert.match(r.message, /You are not signed in/);
    assert.deepEqual(r.serversContacted, [server]);
    assert.equal(h.cookie, "");
    assert.match((await h.get("/")).text_, new RegExp(`Servers contacted: ${server.replace(/[.:/]/g, "\\$&")}`));

    // The seller's files appear in the lot folder after the close; publishing then works and the check passes.
    assert.match((await h.get("/seller")).text_, /disabled>Publish/);
    copyFileSync(join(ROOT, "examples", "round-01", "disclosure.json"), join(lotDir, "disclosure.json"));
    copyFileSync(join(ROOT, "examples", "round-01", "result.json"), join(lotDir, "result.json"));
    assert.equal((await h.post("/seller/publish", {}, false)).status, 303);
    const check = await h.post("/check", { copy: "published" }, false);
    assert.match(check.text_, /<span class="big">PASS<\/span>/);
    assert.ok(!h.logs.join("\n").includes(SITE.ufvk));
  } finally {
    await h.close();
  }
});
