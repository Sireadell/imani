// Locked answers for reading another project's published round on the page.
// These were written before the page code. The page must give the same answers as the command line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkExternalRound } from "../../src/external/published-round.ts";
import { buildEngine, buildSite } from "../../tools/site-build.ts";

const tmp = mkdtempSync(join(tmpdir(), "imani-ext-page-"));
let engine: any;
let appJs = "";
before(async () => {
  await buildEngine(join(tmp, "engine.mjs"));
  await buildSite(join(tmp, "site"));
  appJs = readFileSync(join(tmp, "site", "app.js"), "utf8");
  engine = await import(pathToFileURL(join(tmp, "engine.mjs")).href);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const load = (n: string) => JSON.parse(readFileSync(new URL(`../external/round-files/${n}.json`, import.meta.url), "utf8"));

test("the page tells a published round file from Imani's own files", () => {
  assert.equal(engine.fileKind(load("demo01-settlement")), "external");
  assert.equal(engine.fileKind(load("reveal")), "external");
  assert.equal(engine.fileKind(load("tampered")), "external");
  assert.equal(engine.fileKind({ format: "imani-lot-result/1" }), "result");
  assert.equal(engine.fileKind({ hello: 1 }), null);
});

test("locked answers: settlement passes 6 of 6, reveal passes, tampered fails on the refund amount only", () => {
  const a = engine.runExternalPage(load("demo01-settlement"));
  assert.equal(a.ok, true);
  assert.equal(a.report.result, "PASS");
  assert.equal(a.report.lines.length, 6);
  const b = engine.runExternalPage(load("reveal"));
  assert.equal(b.ok && b.report.result, "PASS");
  const c = engine.runExternalPage(load("tampered"));
  assert.equal(c.ok && c.report.result, "FAIL");
  assert.deepEqual(c.report.lines.filter((l: any) => l.status === "FAIL").map((l: any) => l.id), ["refund-amounts"]);
});

test("the page gives exactly the command line's report, and contacts no server", () => {
  for (const n of ["demo01-settlement", "reveal", "tampered"]) {
    const out = engine.runExternalPage(load(n));
    assert.deepEqual(out.report, checkExternalRound(load(n)), n);
    assert.deepEqual(out.report.serversContacted, []);
  }
});

test("a broken file gets a plain message, never a crash", () => {
  const d = load("demo01-settlement");
  d.settlement = "nope";
  const out = engine.runExternalPage(d);
  assert.equal(out.ok, false);
  assert.ok(out.message.length > 10);
  const odd = engine.runExternalPage({ protocol: "SHIELDBID/1", settlement: [{}] });
  assert.equal(odd.ok, false);
});

test("the built page carries the reader and still makes no network calls", () => {
  assert.doesNotMatch(appJs, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.match(appJs, /runExternalPage|published round/i);
});
