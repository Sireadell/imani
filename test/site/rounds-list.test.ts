// The public list of checked rounds (rounds.html): made at build time from the repo's own files,
// every row re-checks to the stated result, and the page makes no network requests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEngine, buildSite, exampleData } from "../../tools/site-build.ts";
import { roundRows } from "../../tools/rounds-list.ts";

const tmp = mkdtempSync(join(tmpdir(), "imani-rounds-"));
let engine: any;
let html = "";
let indexHtml = "";
let appTs = "";
const DATE = "2026-01-02";

before(async () => {
  process.env.IMANI_CHECKED_DATE = DATE;
  await buildEngine(join(tmp, "engine.mjs"));
  await buildSite(join(tmp, "site"));
  html = readFileSync(join(tmp, "site", "rounds.html"), "utf8");
  indexHtml = readFileSync(join(tmp, "site", "index.html"), "utf8");
  appTs = readFileSync(new URL("../../src/site/app.ts", import.meta.url), "utf8");
  engine = await import(pathToFileURL(join(tmp, "engine.mjs")).href);
  await engine.initReader();
});
after(() => {
  delete process.env.IMANI_CHECKED_DATE;
  rmSync(tmp, { recursive: true, force: true });
});

test("the list has one row per bundled round, and the page shows exactly those rows", () => {
  const { entries, externals } = exampleData();
  const rows = roundRows();
  assert.equal(rows.length, entries.length + externals.length);
  assert.deepEqual(rows.map((r) => r.id).sort(), [...entries.map((e) => e.id), ...externals.map((x) => x.id)].sort());
  assert.equal((html.match(/<tr><td>/g) ?? []).length, rows.length);
  for (const r of rows) assert.ok(html.includes(`<span class="muted small">${r.id}</span>`), r.id);
  // The real round is on the list, with its published block range.
  const real = rows.find((r) => r.id === "testnet-01")!;
  assert.equal(real.kind, "real");
  assert.equal(real.network, "test");
  assert.equal(real.result, "PASS");
});

test("every example row has the result its own files were built to give", () => {
  for (const r of roundRows()) assert.equal(r.expected, true, `${r.id} gave ${r.result} (${r.failing.join(", ")})`);
});

test("every row re-checks to the stated result, in the page's own checker", () => {
  const { entries, externals, blobs } = exampleData();
  const rows = roundRows();
  for (const e of entries) {
    const row = rows.find((r) => r.id === e.id)!;
    const out = engine.runPage({
      disclosure: JSON.parse(blobs[e.disclosure]),
      result: JSON.parse(blobs[e.result]),
      chain: e.chain ? JSON.parse(blobs[e.chain]) : undefined,
    });
    assert.equal(out.ok, true, e.id);
    assert.equal(out.verdict.result, row.result, e.id);
    assert.equal(out.verdict.checks.filter((c: any) => c.status === "PASS").length, row.passed, e.id);
    assert.equal(out.verdict.checks.length, row.total, e.id);
    assert.deepEqual(out.verdict.checks.filter((c: any) => c.status === "FAIL").map((c: any) => c.id), row.failing, e.id);
    assert.equal(out.verdict.network, row.network, e.id);
  }
  for (const x of externals) {
    const row = rows.find((r) => r.id === x.id)!;
    const out = engine.runExternalPage(JSON.parse(blobs[x.blob]));
    assert.equal(out.ok, true, x.id);
    assert.equal(out.report.result, row.result, x.id);
    assert.equal(out.report.lines.filter((l: any) => l.status === "PASS").length, row.passed, x.id);
    assert.equal(out.report.lines.length, row.total, x.id);
  }
});

test("each re-check link opens a round the checker page knows", () => {
  const { entries, externals } = exampleData();
  const hrefs = [...html.matchAll(/<a href="(index\.html#(round|external)=[^"]+)">Re-check it yourself<\/a>/g)];
  assert.equal(hrefs.length, roundRows().length);
  for (const [, href, kind] of hrefs) {
    const id = decodeURIComponent(href.split("=").slice(1).join("="));
    const known = kind === "round" ? entries.some((e) => e.id === id) : externals.some((x) => x.id === id);
    assert.ok(known, href);
  }
  assert.match(readFileSync(new URL("../../src/site/share.ts", import.meta.url), "utf8"), /\(round\|external\)/);
});

test("the checker page links to the list", () => {
  assert.match(indexHtml, /<a href="rounds\.html">Checked rounds<\/a>/);
});

test("the date checked is the build date", () => {
  assert.ok(roundRows().every((r) => r.checked === DATE));
  assert.ok(html.includes(`<td>${DATE}</td>`));
});

test("the list page makes no network requests and shows no key", () => {
  assert.doesNotMatch(html, /<script|<iframe|<img|<link rel="(?!stylesheet|icon)|<form|<object|<embed|<video|<audio|@import|url\(/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline handlers");
  assert.deepEqual(html.match(/https?:\/\/[^\s"'`)]+/g) ?? [], [], "no web addresses at all");
  assert.deepEqual([...html.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1]), []);
  const links = [...html.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.every((l) => l === "style.css" || l === "data:," || /^(index|check)\.html(#[^"]*)?$/.test(l) || /^certificate-[A-Za-z0-9_-]+\.html$/.test(l)), "only local links");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /script-src/);
  assert.doesNotMatch(html, /uview|uivk|uvf|uvi|secret-extended|ufvk/i, "no viewing key on the page");
  for (const d of ["testnet-01", "round-01"]) {
    const ufvk = JSON.parse(readFileSync(new URL(`../../examples/${d}/disclosure.json`, import.meta.url), "utf8")).ufvk;
    assert.ok(!html.includes(ufvk), d);
  }
  assert.doesNotMatch(html, /—/, "no em dash");
});
