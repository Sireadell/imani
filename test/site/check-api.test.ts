// /api/check?round=<name>: the verdict of a shipped round as JSON.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApi, checkRound, ROUNDS } from "../../src/relay/check-api.ts";
import { bundleRelay } from "../../tools/relay-build.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "imani-checkapi-"));
let base = "";
let close = () => {};
before(async () => {
  const s = createServer(checkApi());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => s.close();
});
after(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

test("testnet-01 answers PASS with its counts, range, source and time, in under 2 seconds once the checker is loaded", async () => {
  // The first request of a fresh server also loads the decoder; time the next one.
  const first = Date.now();
  assert.equal((await fetch(`${base}/api/check?round=testnet-01`)).status, 200);
  assert.ok(Date.now() - first < 8000, "first request");
  const t0 = Date.now();
  const res = await fetch(`${base}/api/check?round=testnet-01`);
  const ms = Date.now() - t0;
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.verdict, "PASS");
  assert.equal(j.checks.passed, 21);
  assert.equal(j.checks.total, 21);
  assert.deepEqual(j.blockRange, { from: 4489077, to: 4489110, blocks: 34 });
  assert.equal(j.source.kind, "chain-file");
  assert.equal(j.network, "test");
  assert.equal(typeof j.tookMs, "number");
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.ok(!JSON.stringify(j).includes("uview"), "no viewing key in the answer");
});

test("mainnet-01 answers PASS 23 of 23 on the real mainnet blocks and never shows the key", async () => {
  const res = await fetch(`${base}/api/check?round=mainnet-01`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.verdict, "PASS");
  assert.equal(j.checks.passed, 23);
  assert.equal(j.checks.total, 23);
  assert.deepEqual(j.blockRange, { from: 3532593, to: 3532653, blocks: 61 });
  assert.equal(j.network, "main");
  assert.equal(j.lotId, "IMANI-M1");
  assert.ok(!JSON.stringify(j).includes("uview"), "no viewing key in the answer");
});

test("an unknown round, a missing round and extra parameters are refused", async () => {
  assert.equal((await fetch(`${base}/api/check?round=nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/check`)).status, 400);
  assert.equal((await fetch(`${base}/api/check?round=testnet-01&x=1`)).status, 400);
  assert.equal((await fetch(`${base}/api/check?round=../../etc`)).status, 404);
  assert.equal((await fetch(`${base}/api/check?round=testnet-01`, { method: "POST" })).status, 405);
});

test("a changed result file makes the answer FAIL and names the failed checks", () => {
  cpSync(new URL("examples/testnet-01", root), join(tmp, "testnet-01"), { recursive: true });
  const f = join(tmp, "testnet-01", "result.json");
  const r = JSON.parse(readFileSync(f, "utf8"));
  r.clearingPriceZat += 1;
  writeFileSync(f, JSON.stringify(r));
  const a = checkRound("testnet-01", tmp);
  assert.equal(a.verdict, "FAIL");
  assert.ok(a.failed.length > 0);
  assert.ok(a.checks.passed < a.checks.total);
});

test("every listed round has its files and passes", () => {
  for (const r of ROUNDS) assert.equal(checkRound(r).verdict, "PASS", r);
});

test("api/check.mjs in the repo is the current build and vercel.json ships the round files", async () => {
  const fresh = await bundleRelay(join(tmp, "check.mjs"), "src/relay/check-vercel.ts");
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  assert.equal(norm(rd("api/check.mjs")), norm(fresh).replace("check.mjs", "check.mjs"), "api/check.mjs is out of date: run npm run relay:build");
  for (const i of [...fresh.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])) assert.match(i, /^node:/, i);
  const v = JSON.parse(rd("vercel.json"));
  assert.ok(v.functions["api/check.mjs"].includeFiles.includes("examples/testnet-01"));
  for (const r of ROUNDS) assert.ok(v.functions["api/check.mjs"].includeFiles.includes(`examples/${r}`), r);
});

test("format=svg gives a badge that reads PASS with the same counts, and the JSON answer is unchanged", async () => {
  const json = await (await fetch(`${base}/api/check?round=testnet-01`)).text();
  const res = await fetch(`${base}/api/check?round=testnet-01&format=svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  const svg = await res.text();
  const a = JSON.parse(json);
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes(`PASS ${a.checks.passed}/${a.checks.total}`));
  assert.ok(svg.includes("Imani verified fair"));
  assert.doesNotMatch(svg, /uview|ufvk|<script|href=|http:\/\/(?!www\.w3\.org\/2000\/svg)/i);
  assert.equal(await (await fetch(`${base}/api/check?round=testnet-01`)).text(), json, "JSON unchanged");
});

test("the badge refuses an unknown round, an unknown format and extra parameters, and never draws a badge for them", async () => {
  for (const [q, code] of [["round=nope&format=svg", 404], ["round=testnet-01&format=png", 400], ["format=svg", 400], ["round=testnet-01&format=svg&x=1", 400]] as const) {
    const r = await fetch(`${base}/api/check?${q}`);
    assert.equal(r.status, code, q);
    assert.doesNotMatch(r.headers.get("content-type") ?? "", /svg/, q);
  }
});

test("a round that fails gets a red badge that says FAIL", async () => {
  const dir = join(tmp, "badge-fail");
  cpSync(new URL("examples/testnet-01", root), join(dir, "testnet-01"), { recursive: true });
  const f = join(dir, "testnet-01", "result.json");
  const r = JSON.parse(readFileSync(f, "utf8"));
  r.clearingPriceZat += 1;
  writeFileSync(f, JSON.stringify(r));
  const s = createServer(checkApi(dir));
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/check?round=testnet-01&format=svg`;
    const svg = await (await fetch(url)).text();
    assert.match(svg, /FAIL \d+ of \d+/);
    assert.match(svg, /#a32020/);
    assert.doesNotMatch(svg, /PASS/);
  } finally {
    s.close();
  }
});
