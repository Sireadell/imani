import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refereeRound, type RefereeInput } from "../../src/site/referee.ts";
import { buildSite } from "../../tools/site-build.ts";
import { blockReply, CSP, makeHandler, type BlockReply } from "../../tools/referee-serve.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const disclosure = JSON.parse(rd("examples/testnet-01/disclosure.json"));
const chain = JSON.parse(rd("examples/testnet-01/chain.json"));
const tmp = mkdtempSync(join(tmpdir(), "imani-referee-"));
const siteDir = join(tmp, "site");
let siteFiles: string[] = [];
before(async () => {
  siteFiles = await buildSite(siteDir);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const source = { kind: "light-servers" as const, label: "test blocks", serversContacted: [], bytes: 0, ms: 0 };
const input = (over: Partial<RefereeInput> = {}): RefereeInput => ({
  key: disclosure.ufvk,
  from: 4489077,
  to: 4489110,
  itemCount: 2,
  reserveZat: 1_000_000,
  closeHeight: 4489085,
  blocks: chain.blocks,
  missing: [],
  source,
  ...over,
});
const failed = (o: ReturnType<typeof refereeRound>) => (o.ok ? o.verdict.failed : []);

const LOSER_BID = "2f5e8f4f37650d415dc42867eeda74c70eb06924c117769de048fc5c158d7505";
const LOSER_REFUND = "cca33721ebe9a965850029aabb79301a9b7db33d02f6b82ec9f539b474189fb3";
const dropTx = (txid: string) => chain.blocks.map((b: any) => ({ ...b, txs: b.txs.filter((t: any) => t.txid !== txid) }));

test("the real round on the Zcash test network passes from the key and the block range alone", () => {
  const o = refereeRound(input());
  assert.equal(o.ok, true);
  if (!o.ok) return;
  assert.equal(o.verdict.result, "PASS");
  assert.equal(o.round.lotId, "DRY-01");
  assert.equal(o.round.bidCount, 3);
  assert.equal(o.round.clearingPriceZat, 1_500_000);
  assert.deepEqual(o.round.winners.map((w) => [w.amountZat, w.refundZat]), [[3_000_000, 1_500_000], [2_000_000, 500_000]]);
  assert.deepEqual(o.round.losers.map((l) => l.amountZat), [1_500_000]);
  assert.equal(o.round.refunds.length, 3);
  assert.ok(o.round.refunds.every((r) => r.owedZat === r.paidZat));
  assert.equal(o.verdict.scanLevel, "PASS");
});

test("the numbers equal the ones in the seller's own files for the same round", () => {
  const result = JSON.parse(rd("examples/testnet-01/result.json"));
  const o = refereeRound(input());
  assert.ok(o.ok);
  if (!o.ok) return;
  assert.equal(o.round.bidCount, result.bidCount);
  assert.equal(o.round.clearingPriceZat, result.clearingPriceZat);
  assert.deepEqual(o.round.winners.map((w) => w.txid).sort(), [...result.winners].sort());
});

test("a refund that was never paid fails, naming the check that caught it", () => {
  const o = refereeRound(input({ blocks: dropTx(LOSER_REFUND) }));
  assert.ok(o.ok);
  assert.equal(o.ok && o.verdict.result, "FAIL");
  assert.ok(failed(o).includes("refunds-paid"));
});

test("a bid the key cannot see leaves a refund with no bid behind it, and fails", () => {
  const o = refereeRound(input({ blocks: dropTx(LOSER_BID) }));
  assert.ok(o.ok);
  assert.equal(o.ok && o.verdict.result, "FAIL");
  assert.ok(failed(o).includes("refunds-paid"));
});

test("a missing block means the scan is not complete, so the round fails", () => {
  const blocks = chain.blocks.filter((b: any) => b.height !== 4489090);
  const o = refereeRound(input({ blocks, missing: [4489090] }));
  assert.ok(o.ok);
  assert.ok(failed(o).includes("scan-blocks-read"));
});

test("a wrong reserve changes the price the rules give, so the paid refunds no longer match", () => {
  const o = refereeRound(input({ reserveZat: 1_800_000 }));
  assert.ok(o.ok);
  assert.equal(o.ok && o.verdict.result, "FAIL");
});

test("a seed phrase or a spending key is refused", () => {
  const seed = Array.from({ length: 24 }, () => "abandon").join(" ");
  for (const key of [seed, "secret-extended-key-test1qq", "uivktest1abcdef"]) {
    const o = refereeRound(input({ key }));
    assert.equal(o.ok, false);
    assert.equal(!o.ok && o.kind, "refused");
  }
});

test("a bad range, a bad item count and a range with no bids give plain messages", () => {
  for (const over of [{ from: 5, to: 4 }, { itemCount: 0 }, { reserveZat: -1 }, { closeHeight: 1 }, { to: 4489077 + 6000 }, { lotId: "x y" }]) {
    const o = refereeRound(input(over));
    assert.equal(o.ok, false);
    assert.match(!o.ok ? o.message : "", /^Input error:/);
  }
  const none = refereeRound(input({ from: 4489077, to: 4489078, closeHeight: 4489078, blocks: chain.blocks.filter((b: any) => b.height <= 4489078) }));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.message : "", /no bid/);
  const wrongLot = refereeRound(input({ lotId: "OTHER" }));
  assert.equal(wrongLot.ok, false);
});

test("error messages never contain the key", () => {
  const o = refereeRound(input({ itemCount: 0 }));
  assert.equal(JSON.stringify(o).includes(disclosure.ufvk.slice(20, 60)), false);
});

test("without a close block every bid counts as on time and the page is told so", () => {
  const o = refereeRound(input({ closeHeight: undefined }));
  assert.ok(o.ok);
  assert.equal(o.ok && o.closeAssumed, true);
  assert.equal(o.ok && o.verdict.result, "PASS");
});

// ---- the page and its network rules ----

test("check.html has its own policy: the offline page stays closed, this one allows only its own site", () => {
  const html = rd("src/site/static/check.html");
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /connect-src[^;]*(https?:|\*)/);
  assert.doesNotMatch(csp, /unsafe-inline|'unsafe-eval'/);
  assert.match(rd("src/site/static/index.html"), /connect-src 'none'/);
  assert.equal(CSP.includes("connect-src 'self'"), true);
});

test("check.html names no outside address and says plainly what is sent and what is not", () => {
  const html = rd("src/site/static/check.html");
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /Your key is never sent anywhere/);
  assert.match(html, /only requests for blocks/);
  assert.match(html, /two block servers run by different operators/);
  assert.match(html, /Nothing is sent until you say yes/);
  assert.match(html, /saved block file/);
});

test("the built page code makes only block requests and never puts the key in one", () => {
  const js = readFileSync(join(siteDir, "check.js"), "utf8");
  const urls = [...new Set([...js.matchAll(/fetch\(`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "$")))];
  assert.deepEqual(urls, ["/api/block?network=$&height=$"]);
  assert.equal([...js.matchAll(/\bfetch\(/g)].length, 1);
  assert.doesNotMatch(js, /XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
});

test("the one-press example is the real round in examples/testnet-01", () => {
  const src = rd("src/site/referee-app.ts");
  assert.ok(src.includes(disclosure.ufvk));
  assert.ok(src.includes(`from: "${disclosure.openHeight}"`));
  assert.ok(src.includes(`to: "${disclosure.refundByHeight}"`));
  assert.ok(src.includes(`close: "${disclosure.closeHeight}"`));
  assert.ok(src.includes(`reserve: "${disclosure.rules.reserveZat}"`));
});

test("site:build writes the referee page, its script and its styles, and lists them in SHA256SUMS", () => {
  for (const f of ["check.html", "check.js", "check.css", "index.html", "app.js"]) assert.ok(siteFiles.includes(f), f);
  const sums = readFileSync(join(siteDir, "SHA256SUMS"), "utf8");
  for (const f of ["check.html", "check.js", "check.css"]) assert.match(sums, new RegExp(`  ${f}$`, "m"));
});

// ---- the relay ----

const fakeReply = (h: number): BlockReply => ({
  height: h,
  txs: [],
  answers: [
    { server: "a", hash: "aa", txCount: 1, digest: "d1" },
    { server: "b", hash: "aa", txCount: 1, digest: "d1" },
  ],
  agree: true,
  serversContacted: ["a", "b"],
});

test("the relay shows both servers' answers and flags a disagreement", async () => {
  const fetcher = async () => ({
    transactions: [{ txid: "t", hex: "00", height: 5, server: "https://one.example:443", confirmedBy: [] }],
    serversContacted: ["https://one.example:443", "cipherscan:https://api.two.example"],
    problems: [],
  });
  const same = await blockReply("test", 5, fetcher as any, async (s) => ({ server: s, hash: "h", txCount: 1, digest: "d" }));
  assert.equal(same.agree, true);
  assert.equal(same.answers.length, 2);
  const diff = await blockReply("test", 5, fetcher as any, async (s) => ({ server: s, hash: "h", txCount: 1, digest: s }));
  assert.equal(diff.agree, false);
});

test("the relay takes only a network and a height, refuses other sites and other paths", async () => {
  const calls: [string, number][] = [];
  const server = createServer(makeHandler(siteDir, async (n, h) => (calls.push([n, h]), fakeReply(h))));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/block?network=test&height=4489081`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).height, 4489081);
    assert.equal(ok.headers.get("content-security-policy"), CSP);
    assert.deepEqual(calls, [["test", 4489081]]);
    // A key, or anything else, in the request is refused and never passed on.
    assert.equal((await fetch(`${base}/api/block?network=test&height=1&key=${disclosure.ufvk}`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=regtest&height=1`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=test&height=-3`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=test&height=1`, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
    const page = await fetch(`${base}/check.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Imani referee/);
  } finally {
    server.close();
  }
});

test("the relay reports a failed block as an error", async () => {
  const server = createServer(makeHandler(siteDir, async () => { throw new Error("could not get block 7 from 2 independent servers"); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/block?network=test&height=7`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /could not get block 7/);
  } finally {
    server.close();
  }
});
