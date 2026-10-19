// "Check any round" on the hosted page, without the local helper. Answers locked 2026-10-19
// before the code was written:
// 1. The page asks first. No block is requested until the reader presses the button that says
//    a public Zcash server will be contacted, and that button names exactly which hosts.
// 2. The hosted site answers /api/block through a small function (api/block.mjs) built from the
//    same relay code as the local helper: a network and a height in, nothing else accepted.
// 3. If the servers cannot be reached, a saved block file is checked fully offline, with the same
//    answers as the live servers: the real round passes (3 bids, price 1,500,000, 3 refunds),
//    a dropped refund fails on refunds-paid, a missing block fails on scan-blocks-read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askText } from "../../src/site/ask.ts";
import { checkSavedRound } from "../../src/site/saved-round.ts";
import { DEFAULT_SERVERS } from "../../src/fetch/servers.ts";
import { DEFAULT_SERVERS as FETCH_SERVERS } from "../../src/fetch/index.ts";
import { blockApi } from "../../src/relay/block-api.ts";
import { bundleRelay } from "../../tools/relay-build.ts";
import { buildSite } from "../../tools/site-build.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const disclosure = JSON.parse(rd("examples/testnet-01/disclosure.json"));
const chainText = rd("examples/testnet-01/chain.json");
const chain = JSON.parse(chainText);
const tmp = mkdtempSync(join(tmpdir(), "imani-any-round-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fields = { key: disclosure.ufvk, from: 4489077, to: 4489110, itemCount: 2, reserveZat: 1_000_000, closeHeight: 4489085 };
const LOSER_REFUND = "cca33721ebe9a965850029aabb79301a9b7db33d02f6b82ec9f539b474189fb3";

// ---- 1. ask first ----

test("the ask names this page's own site, the two public servers it may use, the block count, and says the key stays here", () => {
  const t = askText("test", "imani-check.vercel.app", 4489077, 4489110);
  assert.match(t.button, /contact a public Zcash server/i);
  assert.match(t.body, /imani-check\.vercel\.app/);
  assert.match(t.body, /testnet\.zec\.rocks/);
  assert.match(t.body, /api\.testnet\.cipherscan\.app/);
  assert.match(t.body, /34 blocks/);
  assert.match(t.body, /4489077 to 4489110|4,489,077 to 4,489,110/);
  assert.match(t.body, /key is not sent/i);
  assert.doesNotMatch(t.body + t.button, /https?:\/\//);
  assert.ok(!(t.body + t.button).includes(String.fromCharCode(0x2014)), "no long dash in the ask");
  const m = askText("main", "imani-check.vercel.app", 100, 100);
  assert.match(m.body, /1 block\b/);
  for (const s of DEFAULT_SERVERS.main) assert.ok(m.body.includes(s.replace(/^cipherscan:/, "").replace(/^https?:\/\//, "").replace(/:\d+$/, "")), s);
});

test("the page and the fetch code share one list of servers", () => {
  assert.equal(DEFAULT_SERVERS, FETCH_SERVERS);
});

test("in the page code, blocks are requested only from the click on the ask button", () => {
  const src = rd("src/site/referee-app.ts");
  assert.equal([...src.matchAll(/\bfetchBlocks\(/g)].length, 2, "one definition and one call");
  assert.match(src, /\$\("btn-consent"\)\.addEventListener\("click", \(\) => \{\s*void fetchBlocks\(/);
  assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1);
  const html = rd("src/site/static/check.html");
  assert.match(html, /id="ask"[^>]*hidden/);
  assert.match(html, /id="btn-consent"/);
});

// ---- 2. the hosted relay ----

const fakeReply = (h: number) => ({ height: h, txs: [], answers: [], agree: true, serversContacted: ["a", "b"] });

test("the hosted /api/block takes a network and a height only, and refuses keys, other sites and bad input", async () => {
  const calls: [string, number][] = [];
  const handler = blockApi(async (n, h) => (calls.push([n, h]), fakeReply(h)));
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/block?network=test&height=4489081`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).height, 4489081);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/block?network=test&height=1&key=${disclosure.ufvk}`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=regtest&height=1`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=test&height=0`)).status, 400);
    assert.equal((await fetch(`${base}/api/block?network=test&height=1`, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/block?network=test&height=1`, { method: "POST" })).status, 405);
    assert.deepEqual(calls, [["test", 4489081]]);
  } finally {
    server.close();
  }
});

test("api/block.mjs in the repo is the current build of the relay and uses only Node's own modules", async () => {
  const fresh = await bundleRelay(join(tmp, "block.mjs"));
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  assert.equal(norm(rd("api/block.mjs")), norm(fresh), "api/block.mjs is out of date: run npm run relay:build");
  const imports = [...fresh.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const i of imports) assert.match(i, /^node:/, i);
});

test("vercel.json builds the page into site/ and gives the relay enough time", () => {
  const v = JSON.parse(rd("vercel.json"));
  assert.equal(v.buildCommand, "npm run site:build");
  assert.equal(v.outputDirectory, "site");
  assert.ok(v.functions["api/block.mjs"].maxDuration >= 30);
});

// ---- 3. the saved file, offline ----

test("the real round checked from its saved block file passes, with the same numbers as the live servers", () => {
  const o = checkSavedRound(fields, chainText, "chain.json");
  assert.ok(o.ok);
  if (!o.ok) return;
  assert.equal(o.verdict.result, "PASS");
  assert.equal(o.round.bidCount, 3);
  assert.equal(o.round.clearingPriceZat, 1_500_000);
  assert.equal(o.round.refunds.length, 3);
  assert.ok(o.round.refunds.every((r) => r.owedZat === r.paidZat));
});

test("a saved file with a refund taken out fails on refunds-paid", () => {
  const cut = { ...chain, blocks: chain.blocks.map((b: any) => ({ ...b, txs: b.txs.filter((t: any) => t.txid !== LOSER_REFUND) })) };
  const o = checkSavedRound(fields, JSON.stringify(cut), "cut.json");
  assert.ok(o.ok);
  assert.equal(o.ok && o.verdict.result, "FAIL");
  assert.ok(o.ok && o.verdict.failed.includes("refunds-paid"));
});

test("a saved file missing a block in the range fails on scan-blocks-read", () => {
  const cut = { ...chain, blocks: chain.blocks.filter((b: any) => b.height !== 4489090) };
  const o = checkSavedRound(fields, JSON.stringify(cut), "gap.json");
  assert.ok(o.ok);
  assert.ok(o.ok && o.verdict.failed.includes("scan-blocks-read"));
});

test("a file that is not a block file, or is for the other network, gets a plain message", () => {
  for (const [text, re] of [
    ["not json", /Input error/],
    ['{"format":"something"}', /Input error: chain file/],
    [JSON.stringify({ ...chain, network: "main" }), /network/],
  ] as const) {
    const o = checkSavedRound(fields, text, "x.json");
    assert.equal(o.ok, false, text.slice(0, 20));
    assert.match(!o.ok ? o.message : "", re);
    assert.equal(!o.ok && o.message.includes(disclosure.ufvk.slice(20, 60)), false);
  }
});

test("the saved copy of the real round is bundled into the page, so the fallback needs no network either", async () => {
  const dir = join(tmp, "site");
  await buildSite(dir);
  const js = readFileSync(join(dir, "check.js"), "utf8");
  const all = chain.blocks.flatMap((b: any) => b.txs.map((t: any) => t.txHex));
  assert.equal(all.length, 80);
  for (const hex of [all[0], all[all.length - 1]]) assert.ok(js.includes(hex));
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  assert.match(sums, /  check\.js$/m);
  assert.ok(createHash("sha256").update(js).digest("hex").length === 64);
});
