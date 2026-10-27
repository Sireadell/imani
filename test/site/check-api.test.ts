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

test("testnet-01 answers PASS with its counts, range, source and time, in under 2 seconds", async () => {
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
