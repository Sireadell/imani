// The real round on the Zcash test network (examples/testnet-01). The answers below were fixed
// from the first run on 2026-10-11, before these files were added, and must not move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../src/cli.ts";

const ex = (p: string) => new URL(`../../examples/${p}`, import.meta.url);
const path = (p: string) => fileURLToPath(ex(p));
const json = (p: string) => JSON.parse(readFileSync(ex(p), "utf8"));
const CHAIN = path("testnet-01/chain.json");

const check = (disclosure: string, result: string, ...extra: string[]) =>
  run(["check", "--disclosure", path(disclosure), "--result", path(result), "--scan", "--chain", CHAIN, ...extra]);

test("testnet-01: the real round passes 21 of 21 with the scan, offline", () => {
  const r = check("testnet-01/disclosure.json", "testnet-01/result.json");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RESULT: PASS \(21 of 21 checks passed\)/);
  assert.match(r.stdout, /Read all 34 blocks from 4489077 to 4489110 \(80 transactions\)/);
  assert.match(r.stdout, /The lot key sees 6 of them/);
  assert.match(r.stdout, /Servers contacted: none/);
});

test("testnet-01: the key level alone passes 16 of 16", () => {
  const r = run(["check", "--disclosure", path("testnet-01/disclosure.json"), "--result", path("testnet-01/result.json")]);
  assert.match(r.stdout, /RESULT: PASS \(16 of 16 checks passed\)/);
});

test("testnet-01: every payment in the explorer list is one the lot key reads", () => {
  const d = json("testnet-01/disclosure.json");
  const ids = new Set(d.transactions.map((t: { txid: string }) => t.txid));
  const list = json("testnet-01/explorer.json").payments;
  assert.equal(list.length, 6);
  for (const p of list) assert.ok(ids.has(p.txid), p.txid);
  for (const t of d.transactions) assert.equal(t.height, list.find((p: { txid: string }) => p.txid === t.txid).block);
});

const LOCKED: Record<string, string[]> = {
  "01-hidden-losing-bid": ["refunds-paid", "refund-total", "scan-hidden-bids", "scan-unlisted-payments"],
  "02-short-refund-claim": ["result-consistent", "refund-total"],
};

test("testnet-broken: the manifest lists the locked answers", () => {
  const m = json("testnet-broken/manifest.json");
  assert.deepEqual(Object.fromEntries(m.copies.map((c: any) => [c.name, c.expectedFailingChecks])), LOCKED);
});

for (const [name, failing] of Object.entries(LOCKED)) {
  test(`testnet-broken/${name} fails on exactly ${failing.join(", ")}`, () => {
    const own = `testnet-broken/${name}/disclosure.json`;
    const d = existsDisclosure(name) ? own : "testnet-01/disclosure.json";
    const r = check(d, `testnet-broken/${name}/result.json`);
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`RESULT: FAIL \\(${failing.length} of 21 checks failed: ${failing.join(", ")}\\)`));
  });
}

function existsDisclosure(name: string): boolean {
  try {
    readFileSync(ex(`testnet-broken/${name}/disclosure.json`));
    return true;
  } catch {
    return false;
  }
}
