// The package's browser build (@sireadell/imani/browser): one file, reader embedded, no network, same verdict as the command line.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildPackage } from "../tools/package-build.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const root = new URL("../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const out = mkdtempSync(join(tmpdir(), "imani-browser-"));
let mod: any;
let text = "";
before(async () => {
  await buildPackage(out);
  text = readFileSync(join(out, "browser.js"), "utf8");
  mod = await import(pathToFileURL(join(out, "browser.js")).href);
  await mod.initReader();
});
test.after(() => rmSync(out, { recursive: true, force: true }));

test("the browser build checks the real round and a tampered copy like the command line", () => {
  const ok = mod.runPage({ disclosure: JSON.parse(rd("examples/testnet-01/disclosure.json")), result: JSON.parse(rd("examples/testnet-01/result.json")) });
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict.result, "PASS");
  const bad = mod.runPage({ disclosure: JSON.parse(rd("examples/broken/04-short-refund/disclosure.json")), result: JSON.parse(rd("examples/broken/04-short-refund/result.json")) });
  assert.equal(bad.verdict.result, "FAIL");
  assert.deepEqual(bad.verdict.failed, ["refunds-paid"]);
  assert.equal(typeof mod.checkLot, "function");
});

test("the browser build refuses a spending key and makes no network call or Node import", () => {
  const d = JSON.parse(rd("examples/testnet-01/disclosure.json"));
  d.ufvk = "secret-extended-key-test-1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const r = mod.runPage({ disclosure: d, result: JSON.parse(rd("examples/testnet-01/result.json")) });
  assert.equal(r.ok, false);
  assert.doesNotMatch(text, /from\s*["']node:|require\(["']node:|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
});

test("package.json exports @sireadell/imani/browser, is not marked private, and names where the code lives", () => {
  const pkg = JSON.parse(rd("package.json"));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.exports["./browser"].default, "./dist/browser.js");
  assert.ok(pkg.files.includes("dist"));
  assert.match(pkg.repository.url, /Sireadell\/imani/);
});
