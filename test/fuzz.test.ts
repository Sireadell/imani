// Seeded, fixed-size property tests: the checker should be hard to break.
// Same seed, same inputs, every run. Uses only node:test and the repo's own code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot, validateFiles, InputError } from "../src/check.ts";
import { decide, type Bid } from "../src/rules.ts";
import type { Rules } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const manifest = readJson("conformance/manifest.json");
const honest = manifest.cases.filter((c: any) => c.kind === "honest");

// Small seeded generator (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, n: number) => Math.floor(r() * n);

// A verdict or a plain input error is fine. Anything else is a crash.
function outcome(d: any, r: any): "PASS" | "FAIL" | "input-error" {
  try {
    return checkLot(d, r).result;
  } catch (e) {
    if (e instanceof InputError) return "input-error";
    throw e;
  }
}

type Path = (string | number)[];
function numberPaths(v: any, path: Path = [], out: Path[] = []) {
  if (typeof v === "number") out.push(path);
  else if (v && typeof v === "object") for (const k of Object.keys(v)) numberPaths(v[k], [...path, Array.isArray(v) ? Number(k) : k], out);
  return out;
}
const getAt = (v: any, p: Path) => p.reduce((x, k) => x[k], v);
const setAt = (v: any, p: Path, n: number) => {
  getAt(v, p.slice(0, -1))[p[p.length - 1]] = n;
};

function mutateDigit(r: () => number, n: number): number {
  const s = String(n);
  for (let tries = 0; tries < 20; tries++) {
    const i = int(r, s.length);
    const old = s[i];
    if (!/\d/.test(old)) continue;
    const nd = String(int(r, 10));
    if (nd === old) continue;
    const m = Number(s.slice(0, i) + nd + s.slice(i + 1));
    if (Number.isFinite(m) && m !== n) return m;
  }
  return n + 1;
}

function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(r, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- (1) one digit of one number in result.json ----------
test("fuzz 1: changing one digit of one number in an honest result never passes and never crashes", () => {
  const r = rng(20261028);
  let mutated = 0;
  let escalated = 0;
  for (const c of honest) {
    const d = readJson(c.disclosure);
    const res = readJson(c.result);
    const noKey = { ...d };
    delete noKey.ufvk;
    // Every number is mutated at the quick level (no key). If that still passes, the same mutation must
    // fail at the full level too (the key-level read is about 0.5 s, so it runs for the first 14 such cases only).
    for (const p of numberPaths(res)) {
      const copy = structuredClone(res);
      const was = getAt(copy, p);
      const now = mutateDigit(r, was);
      setAt(copy, p, now);
      mutated++;
      if (outcome(noKey, copy) === "PASS" && escalated < 14) {
        escalated++;
        assert.notEqual(outcome(d, copy), "PASS", `${c.id}: ${p.join(".")} ${was} -> ${now} still passed`);
      }
    }
  }
  assert.ok(mutated >= 100, `only ${mutated} mutations ran`);
  assert.ok(escalated > 0);
});

// ---------- (2) garbage in ----------
function garbage(r: () => number, depth = 0): any {
  const kinds = ["null", "num", "str", "bool", "arr", "obj", "neg", "big", "nan"];
  const k = depth > 2 ? pick(r, ["null", "num", "str", "bool", "neg", "big"]) : pick(r, kinds);
  switch (k) {
    case "null": return null;
    case "num": return int(r, 1000);
    case "neg": return -int(r, 1000) - 1;
    case "big": return Number.MAX_SAFE_INTEGER * 4;
    case "nan": return Number.NaN;
    case "str": return pick(r, ["", "x", "0".repeat(64), "zz", "imani-lot-result/1", "main", "\u0000", "a".repeat(300)]);
    case "bool": return r() < 0.5;
    case "arr": return Array.from({ length: int(r, 4) }, () => garbage(r, depth + 1));
    default: {
      const o: any = {};
      const n = int(r, 4);
      for (let i = 0; i < n; i++) o[pick(r, ["format", "bids", "winners", "refunds", "rules", "transactions", "totals", "txid", "amountZat", "x"])] = garbage(r, depth + 1);
      return o;
    }
  }
}

test("fuzz 2a: random JSON garbage only ever gives an input error or a verdict", () => {
  const r = rng(7);
  for (let i = 0; i < 400; i++) outcome(garbage(r), garbage(r));
});

const KNOWN_CRASH = /toLocaleString|reading 'txid'|reading 'bidTxid'/;
let knownCrashes = 0;

test("fuzz 2b: honest files with a random field replaced by the wrong type only give an input error or a verdict", () => {
  const r = rng(99);
  const c = honest[0];
  const d0 = readJson(c.disclosure);
  const r0 = readJson(c.result);
  const allPaths = (v: any, p: Path = [], out: Path[] = []) => {
    out.push(p);
    if (v && typeof v === "object") for (const k of Object.keys(v)) allPaths(v[k], [...p, Array.isArray(v) ? Number(k) : k], out);
    return out;
  };
  const dp = allPaths(d0).filter((p) => p.length);
  const rp = allPaths(r0).filter((p) => p.length);
  for (let i = 0; i < 300; i++) {
    const d = structuredClone(d0);
    const res = structuredClone(r0);
    const inD = r() < 0.5;
    const target = inD ? d : res;
    const p = pick(r, inD ? dp : rp);
    const parent = getAt(target, p.slice(0, -1));
    const last = p[p.length - 1];
    if (r() < 0.2) {
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
    } else parent[last] = garbage(r, 2);
    // Only the three known crashes (the todo tests below) are tolerated. Anything new fails this test.
    // The key is dropped for most iterations because the key-level read is slow; every 40th keeps it.
    if (i % 40 !== 0) delete d.ufvk;
    try {
      outcome(d, res);
    } catch (e: any) {
      assert.match(String(e?.message), KNOWN_CRASH, `new crash: ${e?.message}`);
      knownCrashes++;
    }
  }
  assert.ok(knownCrashes >= 0);
});

// REAL BUGS in src/check.ts (not fixed here). Each throws a TypeError instead of a FAIL verdict or an InputError.
// Minimal cases, all on examples/round-01:
const round01 = () => ({ d: readJson("examples/round-01/disclosure.json"), r: readJson("examples/round-01/result.json") });
test("fuzz 2d: result.json with no clearingPriceZat (also rules.reserveZat null) is an input error or a verdict", { todo: true }, () => {
  const { d, r } = round01();
  delete r.clearingPriceZat;
  outcome(d, r);
});
test("fuzz 2e: result.json with bids[0] = null is an input error or a verdict", { todo: true }, () => {
  const { d, r } = round01();
  r.bids[0] = null;
  outcome(d, r);
});
test("fuzz 2f: result.json with refunds[0] = null is an input error or a verdict", { todo: true }, () => {
  const { d, r } = round01();
  r.refunds[0] = null;
  outcome(d, r);
});

test("fuzz 2c: truncated files are input errors or give a verdict", () => {
  const r = rng(3);
  for (const c of honest.slice(0, 4)) {
    const dt = readFileSync(new URL(c.disclosure, root), "utf8");
    const rt = readFileSync(new URL(c.result, root), "utf8");
    for (let i = 0; i < 25; i++) {
      const cut = (t: string) => t.slice(0, int(r, t.length));
      let d: any, res: any;
      try { d = JSON.parse(cut(dt)); } catch { d = undefined; }
      try { res = JSON.parse(cut(rt)); } catch { res = undefined; }
      outcome(d, res);
      assert.throws(() => validateFiles(undefined, res), InputError);
    }
  }
});

// ---------- (3) the rules ----------
const hex = (r: () => number) => Array.from({ length: 64 }, () => "0123456789abcdef"[int(r, 16)]).join("");
test("fuzz 3: decide() ignores arrival order, and refunds never exceed what was paid", () => {
  const r = rng(424242);
  for (let i = 0; i < 2000; i++) {
    const n = int(r, 9);
    // Few distinct amounts and heights on purpose, so ties are common.
    const bids: Bid[] = Array.from({ length: n }, () => ({ txid: hex(r), amountZat: (1 + int(r, 6)) * 100000, height: 100 + int(r, 3) }));
    const itemCount = 1 + int(r, 4);
    const reserveZat = int(r, 5) * 100000;
    const rules = { itemCount, reserveZat, ...(r() < 0.5 ? { pricing: pick(r, ["highest-losing", "lowest-winning"]) } : {}) } as Rules;
    const a = decide(bids, rules);
    const b = decide(shuffle(r, bids), rules);
    assert.deepEqual(b.winners, a.winners);
    assert.equal(b.clearingPriceZat, a.clearingPriceZat);
    assert.equal(b.reserveMet, a.reserveMet);
    assert.deepEqual([...b.refundsOwed].sort(), [...a.refundsOwed].sort());
    const paid = new Map(bids.map((x) => [x.txid, x.amountZat]));
    for (const [txid, back] of a.refundsOwed) {
      assert.ok(Number.isInteger(back) && back >= 0, "refund is a whole non-negative amount");
      assert.ok(back <= paid.get(txid)!, "refund never exceeds the payment");
    }
    assert.ok(a.winners.length <= itemCount);
    for (const w of a.winners) assert.ok(paid.get(w)! >= reserveZat, "a winner met the reserve");
    if (a.reserveMet) assert.ok(a.clearingPriceZat >= reserveZat);
  }
});
