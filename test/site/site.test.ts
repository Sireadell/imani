import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../../src/cli.ts";
import { createHash as shimHash, sha256Hex } from "../../src/site/crypto-shim.ts";
import { buildEngine, buildSite, exampleData } from "../../tools/site-build.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "imani-site-"));
let engine: any;
let siteFiles: string[] = [];
const siteDir = join(tmp, "site");

before(async () => {
  await buildEngine(join(tmp, "engine.mjs"));
  siteFiles = await buildSite(siteDir);
  engine = await import(pathToFileURL(join(tmp, "engine.mjs")).href);
  await engine.initReader();
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const ex = (p: string) => JSON.parse(rd(`examples/${p}`));
const exPath = (p: string) => new URL(`examples/${p}`, root).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const brokenNames: string[] = ex("broken/manifest.json").copies.map((c: any) => c.name);
const scanNames: string[] = ex("scan-broken/manifest.json").copies.map((c: any) => c.name);

function cliVerdict(dir: string, extra: string[] = []) {
  const out = join(tmp, "out-" + Math.random().toString(36).slice(2));
  const res = run(["check", "--disclosure", exPath(`${dir}/disclosure.json`), "--result", exPath(`${dir}/result.json`), "--out", out, ...extra]);
  return { res, verdict: JSON.parse(readFileSync(join(out, "verdict.json"), "utf8")) };
}

test("the pure JavaScript SHA-256 equals Node's", () => {
  for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "uview1" + "q".repeat(300)]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"));
    assert.equal(shimHash("sha256").update(s).digest("hex"), createHash("sha256").update(s).digest("hex"));
  }
});

test("page logic equals the command line for round-01 (the browser reader gives the same verdict)", () => {
  const { verdict } = cliVerdict("round-01");
  const out = engine.runPage({ disclosure: ex("round-01/disclosure.json"), result: ex("round-01/result.json") });
  assert.equal(out.ok, true);
  assert.deepEqual(out.verdict, verdict);
  assert.equal(out.verdict.result, "PASS");
  assert.equal(out.verdict.checks.length, 15);
  assert.equal(engine.serversLine(out.verdict).startsWith("none"), true);
});

test("page logic equals the command line for all 6 broken copies, each failing its named check", () => {
  assert.equal(brokenNames.length, 6);
  const expected: Record<string, string> = Object.fromEntries(ex("broken/manifest.json").copies.map((c: any) => [c.name, c.expectedFailingCheck]));
  for (const name of brokenNames) {
    const { verdict, res } = cliVerdict(`broken/${name}`);
    const out = engine.runPage({ disclosure: ex(`broken/${name}/disclosure.json`), result: ex(`broken/${name}/result.json`) });
    assert.equal(out.ok, true, name);
    assert.deepEqual(out.verdict, verdict, name);
    assert.equal(res.code, 1);
    assert.deepEqual(out.verdict.failed, [expected[name]], name);
  }
});

test("discreet mode gives the same verdict as the command line and shows no amounts or memos", () => {
  const { verdict } = cliVerdict("round-01", ["--discreet"]);
  const out = engine.runPage({ disclosure: ex("round-01/disclosure.json"), result: ex("round-01/result.json"), discreet: true });
  assert.deepEqual(out.verdict, verdict);
  const text = JSON.stringify(out.verdict);
  assert.doesNotMatch(text, /1,500,000|3,000,000|"bid:/);
  assert.match(text, /\[hidden\]/);
});

test("scan examples: page logic equals the command line checks, with the named scan failure", () => {
  const scanRun = (dir: string) => {
    const d = ex(`${dir}/disclosure.json`);
    const r = ex(`${dir}/result.json`);
    const chain = ex(`${dir}/chain.json`);
    const page = engine.runPage({ disclosure: d, result: r, chain, chainLabel: "chain.json" });
    const out = join(tmp, "scan-" + Math.random().toString(36).slice(2));
    run(["check", "--disclosure", exPath(`${dir}/disclosure.json`), "--result", exPath(`${dir}/result.json`), "--scan", "--chain", exPath(`${dir}/chain.json`), "--out", out]);
    const cli = JSON.parse(readFileSync(join(out, "verdict.json"), "utf8"));
    return { page: page.verdict, cli };
  };
  const honest = scanRun("scan-01");
  assert.equal(honest.page.result, "PASS");
  assert.equal(honest.page.checks.length, 20);
  assert.deepEqual(honest.page.checks, honest.cli.checks);
  const expected: Record<string, string> = Object.fromEntries(ex("scan-broken/manifest.json").copies.map((c: any) => [c.name, c.expectedFailingCheck]));
  for (const name of scanNames) {
    const { page, cli } = scanRun(`scan-broken/${name}`);
    assert.deepEqual(page.checks, cli.checks, name);
    assert.deepEqual(page.failed, [expected[name]], name);
  }
});

test("refund address examples: page logic equals the command line, with the named failure", () => {
  const honest = cliVerdict("receivers-01");
  const page = engine.runPage({ disclosure: ex("receivers-01/disclosure.json"), result: ex("receivers-01/result.json") });
  assert.deepEqual(page.verdict, honest.verdict);
  assert.equal(page.verdict.result, "PASS");
  assert.equal(page.verdict.checks.length, 16);
  for (const c of ex("receivers-broken/manifest.json").copies) {
    const dir = `receivers-broken/${c.name}`;
    const cli = cliVerdict(dir);
    const out = engine.runPage({ disclosure: ex(`${dir}/disclosure.json`), result: ex(`${dir}/result.json`) });
    assert.deepEqual(out.verdict, cli.verdict, c.name);
    assert.deepEqual(out.verdict.failed, [c.expectedFailingCheck], c.name);
  }
});

test("bid memo address examples: page logic equals the command line, with the named failure", () => {
  const honest = cliVerdict("memo-01");
  const page = engine.runPage({ disclosure: ex("memo-01/disclosure.json"), result: ex("memo-01/result.json") });
  assert.deepEqual(page.verdict, honest.verdict);
  assert.equal(page.verdict.result, "PASS");
  for (const c of ex("memo-broken/manifest.json").copies) {
    const dir = `memo-broken/${c.name}`;
    const out = engine.runPage({ disclosure: ex(`${dir}/disclosure.json`), result: ex(`${dir}/result.json`) });
    assert.deepEqual(out.verdict.failed, [c.expectedFailingCheck], c.name);
  }
});

test("the page answers Was my bid counted? the same way the command line does", () => {
  const r = ex("memo-01/result.json");
  const page = engine.runPage({ disclosure: ex("memo-01/disclosure.json"), result: r });
  const text = engine.lookupBid(r, page.verdict, r.winners[0].slice(0, 12));
  assert.match(text, /Your bid: counted, 3,000,000 zat./);
  assert.match(text, /refund went to your address: PASS/);
  assert.match(text, /Whole auction: PASS/);
});

test("spending keys and seed phrases are refused, and the key never appears in the outcome", () => {
  const d = ex("round-01/disclosure.json");
  const r = ex("round-01/result.json");
  const secrets = [
    "secret-extended-key-test1q" + "q".repeat(60),
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "uivk1" + "q".repeat(60),
  ];
  for (const s of secrets) {
    const out = engine.runPage({ disclosure: { ...d, ufvk: s }, result: r });
    assert.equal(out.ok, false);
    assert.equal(out.kind, "refused");
    assert.ok(!out.message.includes(s));
    assert.match(out.message, /^Refused:/);
  }
  const good = engine.runPage({ disclosure: d, result: r });
  assert.ok(!JSON.stringify(good).includes(d.ufvk), "the lot key is not in the verdict");
});

test("bad input gives a plain message, not a crash", () => {
  assert.equal(engine.runPage({ disclosure: {}, result: {} }).kind, "input");
  assert.throws(() => engine.parseJsonText("not json", "result"), /not valid JSON/);
  const d = ex("scan-01/disclosure.json");
  const wrongNet = { ...ex("scan-01/chain.json"), network: "main" };
  assert.equal(engine.runPage({ disclosure: d, result: ex("scan-01/result.json"), chain: wrongNet }).kind, "input");
  assert.equal(engine.fileKind(d), "disclosure");
  assert.equal(engine.fileKind({ format: "other" }), null);
});

test("the built decoder is the vendored one: embedded wasm bytes match SHA256SUMS", () => {
  const sums = rd("vendor/decoder/SHA256SUMS");
  const want = /^([0-9a-f]{64})\s+imani_decoder_bg\.wasm$/m.exec(sums)![1];
  const bytes: Uint8Array = engine.decoderBytes();
  assert.equal(sha256Hex(bytes), want);
  assert.equal(createHash("sha256").update(readFileSync(new URL("vendor/decoder/imani_decoder_bg.wasm", root))).digest("hex"), want);
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.ok(app.includes(readFileSync(new URL("vendor/decoder/imani_decoder_bg.wasm", root)).toString("base64")));
  assert.match(readFileSync(join(siteDir, "SHA256SUMS"), "utf8"), new RegExp(`${want}\\s+imani_decoder_bg.wasm`));
});

/** The page code with long data strings (examples, wasm bytes) removed. */
function codeOnly(js: string): string {
  return js.replace(/"(?:[^"\\\n]|\\.){1500,}"/g, '""');
}

const MAINNET_FILES = "https://github.com/Sireadell/imani/tree/main/examples/mainnet-01";

test("the home page shows the real mainnet round with its live answer, its files and the re-check command", () => {
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const box = html.slice(html.indexOf('<section id="mainnet-round"'), html.indexOf("</section>", html.indexOf('<section id="mainnet-round"')));
  assert.ok(box.length > 0, "mainnet section");
  assert.ok(html.indexOf('id="mainnet-round"') < html.indexOf("</header>"), "it sits near the real round, above the long sections");
  assert.ok(box.includes('<a href="/api/check?round=mainnet-01">'));
  assert.ok(box.includes(`<a href="${MAINNET_FILES}"`));
  for (const s of ["IMANI-M1", "0.013 ZEC", "3,532,593 to 3,532,653", "482 transactions", "23 of 23", "3 separate wallets that we ran", "--fetch"]) assert.ok(box.includes(s), s);
  // The command is the one the round's README gives.
  const readme = rd("examples/mainnet-01/README.md");
  const cmd = /node bin\/imani\.js check [^\n]*--chain examples\/mainnet-01\/chain\.json/.exec(readme)![0];
  assert.ok(box.includes(cmd), "same command as examples/mainnet-01/README.md");
  // The page opens on the mainnet round and checks it in the browser.
  assert.ok(readFileSync(join(siteDir, "app.js"), "utf8").includes("IMANI-M1"));
});

test("the built page makes no network calls and has no external hosts", () => {
  const js = codeOnly(readFileSync(join(siteDir, "app.js"), "utf8"));
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const css = readFileSync(join(siteDir, "style.css"), "utf8");
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /EventSource/, /importScripts/, /\bimport\s*\(/, /new\s+Worker\b/, /WebTransport/, /\.src\s*=/, /localStorage|sessionStorage|indexedDB|document\.cookie/];
  for (const re of banned) assert.doesNotMatch(js, re, String(re));
  // The only addresses allowed are the real round's explorer links. They are plain links that
  // load nothing unless the reader clicks one, and they open in a new tab with no referrer.
  // The SVG namespace name is an identifier the bid link's QR picture needs, not an address anything loads.
  const urls = (js.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== "http://www.w3.org/2000/svg");
  const explorer = JSON.parse(rd("examples/testnet-01/explorer.json"));
  assert.deepEqual(urls.sort(), explorer.payments.map((p: { txid: string }) => `${explorer.explorer}${p.txid}`).sort(), "no URLs in the code except the explorer links");
  for (const u of urls) assert.match(u, /^https:\/\/testnet\.zecblock\.com\/tx\/[0-9a-f]{64}$/);
  assert.match(rd("src/site/app.ts"), /a\.rel = "noopener noreferrer"/);
  // The one address in the html is a plain link to the mainnet round's files, opened in a new tab with no referrer.
  assert.deepEqual((html + css).match(/https?:\/\/[^\s"'`)]+/g) ?? [], [MAINNET_FILES], "no URLs in html or css except the mainnet files link");
  assert.ok(html.includes(`<a href="${MAINNET_FILES}" target="_blank" rel="noopener noreferrer">`));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(css.replace(/url\(data:font\/woff2;base64,[A-Za-z0-9+\/=]+\)/, ""), /@import|url\(/, "the only url in the stylesheet is the embedded font");
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(), ["/api/check?round=mainnet-01", MAINNET_FILES, "app.js", "check.html", "data:,", "rounds.html", "style.css", "#top", "#top", "#bid-box", "#bid-box", "#own-h", "#own-h", "#pick-h", "#pick-h"].sort());
  // check.html, check.js and check.css are the referee page, which has its own policy (see referee.test.ts); the offline page above never loads them.
  // certificate-<round>.html and certificate.css are the printable certificates (certificate.test.ts holds their own rules).
  assert.deepEqual([...siteFiles].filter((f) => !/^certificate-[A-Za-z0-9_-]+\.html$/.test(f)).sort(), ["SHA256SUMS", "app.js", "certificate.css", "check.css", "check.html", "check.js", "index.html", "rounds.html", "style.css"]);
});

test("running every example with network functions trapped never calls them", async () => {
  const g = globalThis as any;
  const calls: string[] = [];
  const saved: Record<string, any> = {};
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    saved[name] = g[name];
    g[name] = function () {
      calls.push(name);
      throw new Error(`network call: ${name}`);
    };
  }
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  const net = (await import("node:net")).default;
  const origs = [http.request, https.request, net.connect];
  (http as any).request = () => { calls.push("http.request"); throw new Error("net"); };
  (https as any).request = () => { calls.push("https.request"); throw new Error("net"); };
  (net as any).connect = () => { calls.push("net.connect"); throw new Error("net"); };
  try {
    const d = ex("round-01/disclosure.json");
    assert.equal(engine.runPage({ disclosure: d, result: ex("round-01/result.json") }).ok, true);
    for (const n of brokenNames) engine.runPage({ disclosure: ex(`broken/${n}/disclosure.json`), result: ex(`broken/${n}/result.json`) });
    engine.runPage({ disclosure: ex("scan-01/disclosure.json"), result: ex("scan-01/result.json"), chain: ex("scan-01/chain.json") });
    engine.runPage({ disclosure: { ...d, ufvk: "secret-extended-key-test1" + "q".repeat(60) }, result: ex("round-01/result.json") });
  } finally {
    for (const [k, v] of Object.entries(saved)) g[k] = v;
    (http as any).request = origs[0];
    (https as any).request = origs[1];
    (net as any).connect = origs[2];
  }
  assert.deepEqual(calls, []);
});

test("every bundled example is in the page and all expected outcomes hold", () => {
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  for (const id of ["testnet-01", "testnet-broken/01-hidden-losing-bid", "testnet-broken/02-short-refund-claim", "round-01", "scan-01", ...brokenNames.map((n) => `broken/${n}`), ...scanNames.map((n) => `scan-broken/${n}`)]) {
    assert.ok(app.includes(`"id":"${id}"`) || app.includes(`"id": "${id}"`), id);
  }
});

test("page text rules: plain words, no banned claims, no em dashes", () => {
  const files = [
    "src/site/static/index.html",
    "src/site/static/style.css",
    "src/site/app.ts",
    "src/site/engine.ts",
    "src/site/read-browser.ts",
    "src/site/reader.ts",
    "src/site/crypto-shim.ts",
    "tools/site-build.ts",
    "tools/site-serve.ts",
    "docs/site/README.md",
  ];
  for (const f of files) {
    const t = rd(f);
    assert.ok(!t.includes("—"), `${f} has an em dash`);
    assert.doesNotMatch(t, /trustless/i, f);
    assert.doesNotMatch(t, /\bfirst\b/i, f);
  }
  const html = rd("src/site/static/index.html");
  const zk = html.match(/[^.]*zero-knowledge[^.]*\./gi) ?? [];
  assert.equal(zk.length, 1);
  assert.match(zk[0], /not a zero-knowledge proof/i);
  assert.match(html, /name="viewport"/);
  assert.match(html, /Servers contacted: none/);
  assert.match(html, /one-time viewing key/);
  assert.match(html, /seller can see bids/i);
  assert.match(html, /Try a tampered copy/);
  assert.ok(readdirSync(join(siteDir)).length > 0);
});

test("the page has one button per example, a nav slot for Check any round, and a checking notice", () => {
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const js = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.equal((html.match(/<a href="check.html">Check any round<\/a>/g) ?? []).length, 1);
  for (const id of ["btn-real", "btn-real-cheat", "btn-honest", "btn-tamper"]) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.match(js, /Checking\.\.\./);
});

test("the first screen: the real round, one check button, an honest or cheated switch, and the private box", () => {
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const hero = html.slice(html.indexOf('<header class="top hero">'), html.indexOf("</header>"));
  assert.match(hero, /<h1>A fairness certificate for every sealed Zcash auction\.<\/h1>/);
  assert.equal((hero.match(/>Check it yourself<\/button>/g) ?? []).length, 1);
  assert.match(hero, />Honest round<\/button>/);
  assert.match(hero, />Cheated copy<\/button>/);
  assert.match(hero, /Servers contacted: none/);
  assert.match(hero, /What the check proved/);
  const priv = hero.slice(hero.indexOf("What stayed private"), hero.indexOf("</ul>", hero.indexOf("What stayed private"))).replace(/<[^>]*>/g, " ").replace("What stayed private", "");
  assert.doesNotMatch(priv, /\d|zat|ZEC|u1|utest|memo/i, "the private box names no amount, address or memo");
  // The old tool sections are still lower on the page.
  for (const id of ["pick-h", "own-h", "mine-h", "bid-h", "ext-h", "who-h", "lim-h"]) assert.ok(html.indexOf(`id="${id}"`) > html.indexOf("</header>"), id);
  assert.doesNotMatch(html, /MOCKUP|placeholder figures/i);
});

test("the first screen runs the real round to PASS and the cheated copy to FAIL, and its lines map to real checks", () => {
  const app = rd("src/site/app.ts");
  const round = /const HOME_ROUND = "([^"]+)"/.exec(app)![1];
  const cheat = /const HOME_CHEAT = "([^"]+)"/.exec(app)![1];
  const honest = cliVerdict(round === "testnet-01" ? "testnet-01" : round);
  const page = engine.runPage({ disclosure: ex(`${round}/disclosure.json`), result: ex(`${round}/result.json`), chain: ex(`${round}/chain.json`), chainLabel: "chain.json" });
  assert.equal(page.verdict.result, "PASS");
  assert.equal(honest.verdict.result, "PASS");
  const data = exampleData();
  const entry = data.entries.find((e: any) => e.id === cheat)!;
  assert.ok(entry, "the cheated copy is bundled");
  const bad = engine.runPage({ disclosure: JSON.parse(data.blobs[entry.disclosure]), result: JSON.parse(data.blobs[entry.result]), chain: JSON.parse(data.blobs[entry.chain]), chainLabel: "chain.json" });
  assert.equal(bad.verdict.result, "FAIL");
  assert.ok(bad.verdict.failed.includes("scan-hidden-bids"));
  const ids = new Set(page.verdict.checks.map((c: any) => c.id));
  const lines = [...app.matchAll(/ids: \[([^\]]*)\] \}/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.ok(lines.length >= 5);
  assert.ok(lines.filter((id) => ids.has(id)).length >= 5, "the line texts point at checks the honest run really has");
});
