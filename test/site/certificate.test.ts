// The printable fairness certificate: built from the real checker, one page per checked round.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRound } from "../../src/relay/check-api.ts";
import { buildSite } from "../../tools/site-build.ts";
import { certificateFile } from "../../tools/certificate.ts";
import { roundRows } from "../../tools/rounds-list.ts";

const tmp = mkdtempSync(join(tmpdir(), "imani-cert-"));
const siteDir = join(tmp, "site");
before(async () => { await buildSite(siteDir); });
after(() => rmSync(tmp, { recursive: true, force: true }));
const page = (id: string) => readFileSync(join(siteDir, certificateFile(id)), "utf8");

test("there is one certificate per checked round, each linked from the list", () => {
  const rows = roundRows();
  const files = new Set(readdirSync(siteDir));
  const list = readFileSync(join(siteDir, "rounds.html"), "utf8");
  for (const r of rows) {
    assert.ok(files.has(certificateFile(r.id)), r.id);
    assert.ok(list.includes(`href="${certificateFile(r.id)}"`), r.id);
  }
});

test("the testnet-01 certificate says PASS with the same counts as /api/check", () => {
  const api = checkRound("testnet-01");
  const html = page("testnet-01");
  assert.match(html, /class="pass">PASS</);
  assert.ok(html.includes(`${api.checks.passed} of ${api.checks.total}`), "check counts");
  assert.ok(html.includes(api.blockRange!.from.toLocaleString("en-US")) && html.includes(api.blockRange!.to.toLocaleString("en-US")), "block range");
  assert.match(html, /Zcash test network/);
  assert.match(html, /<th scope="row">Bids<\/th><td>3</);
});

test("a tampered copy prints FAIL and names the failed check", () => {
  const bad = roundRows().find((r) => r.result === "FAIL")!;
  const html = page(bad.id);
  assert.match(html, /class="fail">FAIL</);
  assert.match(html, /Failed checks/);
  for (const id of bad.failing) assert.ok(html.includes(id), id);
});

test("a certificate holds no key, no script, no network, and fits one A4 page", () => {
  for (const r of roundRows()) {
    const html = page(r.id);
    assert.doesNotMatch(html, /uview1|ufvk|utest1|u1[a-z0-9]{40}|<script|http:\/\//i, r.id);
    assert.match(html, /connect-src 'none'/);
    assert.ok((html.match(/<tr>/g) ?? []).length <= 11, `${r.id} too many rows for one page`);
  }
  assert.match(readFileSync(join(siteDir, "certificate.css"), "utf8"), /size: A4/);
});

test("certificate text has no em dashes and makes no claim beyond the check", () => {
  const html = page("testnet-01");
  assert.doesNotMatch(html, /—/);
  assert.match(html, /never holds money and does not run auctions/);
  assert.match(html, /can't prove the seller didn't look at bids/);
});
