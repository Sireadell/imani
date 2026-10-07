import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLot } from "../src/check.ts";
import { run } from "../src/cli.ts";
import { decide } from "../src/rules.ts";

const ex = (p: string) => new URL(`../examples/${p}`, import.meta.url);
const load = (dir: string) => ({
  d: JSON.parse(readFileSync(ex(`${dir}/disclosure.json`), "utf8")),
  r: JSON.parse(readFileSync(ex(`${dir}/result.json`), "utf8")),
});
const path = (dir: string, f: string) => fileURLToPath(ex(`${dir}/${f}`));
const cli = (dir: string, ...extra: string[]) =>
  run(["check", "--disclosure", path(dir, "disclosure.json"), "--result", path(dir, "result.json"), ...extra]);
const round = load("round-01");
const KEY = round.d.ufvk as string;

test("round-01 passes every check at both levels", () => {
  const v = checkLot(round.d, round.r);
  assert.equal(v.result, "PASS");
  assert.equal(v.basicLevel, "PASS");
  assert.equal(v.keyLevel, "PASS");
  assert.deepEqual(v.failed, []);
  assert.equal(v.checks.length, 15);
  assert.deepEqual(v.serversContacted, []);
});

test("CLI prints PASS, exit code 0, and says no server was contacted", () => {
  const res = cli("round-01");
  assert.equal(res.code, 0);
  assert.match(res.stdout, /RESULT: PASS/);
  assert.match(res.stdout, /Servers contacted: none/);
});

const manifest = JSON.parse(readFileSync(ex("broken/manifest.json"), "utf8"));
test("there are six broken copies", () => assert.equal(manifest.copies.length, 6));
for (const copy of manifest.copies) {
  test(`broken copy ${copy.name} fails on ${copy.expectedFailingCheck} only`, () => {
    const { d, r } = load(`broken/${copy.name}`);
    const v = checkLot(d, r);
    assert.equal(v.result, "FAIL");
    assert.deepEqual(v.failed, [copy.expectedFailingCheck]);
    const res = cli(`broken/${copy.name}`);
    assert.equal(res.code, 1);
    assert.match(res.stdout, new RegExp(`RESULT: FAIL \\(1 of 15 checks failed: ${copy.expectedFailingCheck}\\)`));
  });
}

test("basic level runs without any key and needs no secret", () => {
  const d = { ...round.d };
  delete d.ufvk;
  const v = checkLot(d, round.r);
  assert.equal(v.result, "PASS");
  assert.equal(v.keyLevel, "not run");
  assert.ok(v.checks.every((c) => c.level === 1));
  const res = cli("round-01", "--basic");
  assert.equal(res.code, 0);
  assert.match(res.stdout, /basic level only/);
  assert.match(res.stdout, /Lot key: not used/);
});

test("basic level catches a result file that contradicts itself", () => {
  const r = structuredClone(round.r);
  r.bidCount = 5;
  r.clearingPriceZat = 9_000_000;
  const v = checkLot(round.d, r, { basicOnly: true });
  assert.deepEqual(v.failed, ["result-consistent", "clearing-range"]);
  const d = structuredClone(round.d);
  d.transactions.push(d.transactions[0]);
  d.closeHeight = 0;
  assert.deepEqual(checkLot(d, round.r, { basicOnly: true }).failed, ["close-height", "disclosure-txids-unique"]);
});

const SEED = "abandon ".repeat(23) + "art";
const refused: [string, string][] = [
  ["seed phrase", SEED],
  ["spending key", "secret-extended-key-test1qwerty0asdfgh"],
  ["unified spending key", "uskt1qqqqqqqqqqqqqqqqqqqqqqqq"],
  ["incoming-only key", "uivktest1qqqqqqqqqqqqqqqqqqqqqq"],
  ["random text", "hello-this-is-not-a-key"],
  ["main network key on a test lot", "uview1" + KEY.slice("uviewtest1".length)],
];
for (const [name, key] of refused) {
  test(`refuses a ${name} and never repeats it`, () => {
    const dir = mkdtempSync(join(tmpdir(), "imani-"));
    try {
      const d = { ...round.d, ufvk: key };
      const dp = join(dir, "d.json");
      writeFileSync(dp, JSON.stringify(d));
      const res = run(["check", "--disclosure", dp, "--result", path("round-01", "result.json"), "--out", join(dir, "out")]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /^Refused: /);
      assert.match(res.stderr, /Servers contacted: none/);
      assert.ok(!res.stderr.includes(key) && !res.stdout.includes(key));
      assert.ok(!res.stderr.includes(key.slice(10, 40)));
      assert.deepEqual(readdirSync(dir), ["d.json"], "nothing written after a refusal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}


test("the lot key is never printed or written, in normal and discreet mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-"));
  try {
    for (const flags of [[], ["--discreet"]]) {
      for (const lot of ["round-01", "broken/03-missing-refund"]) {
        const out = join(dir, lot.replace("/", "_") + flags.join(""));
        const res = cli(lot, "--out", out, ...flags);
        const files = [readFileSync(join(out, "verdict.json"), "utf8"), readFileSync(join(out, "report.html"), "utf8")];
        for (const text of [res.stdout, res.stderr, ...files]) {
          assert.ok(!text.includes(KEY), "full key found");
          assert.ok(!text.includes(KEY.slice(10, 40)), "part of the key found");
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transaction that cannot be read gives an error without the key", () => {
  const d = structuredClone(round.d);
  d.transactions[0].txHex = "05000080" + "00".repeat(20);
  const dir = mkdtempSync(join(tmpdir(), "imani-"));
  try {
    const dp = join(dir, "d.json");
    writeFileSync(dp, JSON.stringify(d));
    const res = run(["check", "--disclosure", dp, "--result", path("round-01", "result.json")]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /could not be read/);
    assert.ok(!res.stderr.includes(KEY.slice(10, 40)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("payments outside the lot fail the key-hygiene check and ask for a fresh key", () => {
  for (const g of ["guards/outside-payment", "guards/other-lot-bid"]) {
    const { d, r } = load(g);
    const v = checkLot(d, r);
    assert.deepEqual(v.failed, ["key-hygiene"], g);
    assert.match(v.checks.find((c) => c.id === "key-hygiene")!.reason, /fresh one-time key for every lot/);
  }
});

test("a replayed bid is detected and not counted as a new bid", () => {
  const { d, r } = load("guards/replayed-bid");
  const v = checkLot(d, r);
  assert.ok(v.failed.includes("no-duplicate-bids"));
  assert.ok(!v.failed.includes("bid-count"));
  assert.ok(!v.failed.includes("winners-and-price"));
});

test("discreet mode hides amounts and memos in the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-"));
  try {
    const res = cli("guards/outside-payment", "--discreet", "--out", dir);
    const html = readFileSync(join(dir, "report.html"), "utf8");
    for (const text of [res.stdout, html]) {
      assert.ok(!/\d{1,3},\d{3},\d{3}/.test(text), "an amount is visible");
      assert.ok(!text.includes("coffee order"), "a memo is visible");
      assert.ok(text.includes("[hidden]"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report.html is self-contained: no scripts, nothing loaded from the internet", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-"));
  try {
    cli("broken/05-wrong-clearing-price", "--out", dir);
    const html = readFileSync(join(dir, "report.html"), "utf8");
    assert.ok(!/<script/i.test(html));
    assert.ok(!/(src|href)\s*=/i.test(html));
    assert.ok(!/https?:\/\//i.test(html));
    assert.match(html, /From the chain \(read with the lot key\)/);
    assert.match(html, /From the seller's result file/);
    const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
    assert.deepEqual(v.failed, ["winners-and-price"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("price rule: uniform price, reserve, ties", () => {
  const rules = { itemCount: 2, reserveZat: 100 };
  const b = (txid: string, amountZat: number, height = 1) => ({ txid, amountZat, height });
  // Highest losing bid sets the price.
  assert.deepEqual(decide([b("a", 300), b("b", 200), b("c", 150)], rules).clearingPriceZat, 150);
  // Every bid wins: price is the reserve.
  const all = decide([b("a", 300), b("b", 200)], rules);
  assert.deepEqual([all.winners, all.clearingPriceZat], [["a", "b"], 100]);
  // Losing bid below the reserve: price is the reserve.
  assert.equal(decide([b("a", 300), b("b", 200), b("c", 50)], rules).clearingPriceZat, 100);
  // No bid reaches the reserve: no winners, everyone refunded.
  const none = decide([b("a", 90), b("b", 80)], rules);
  assert.deepEqual([none.reserveMet, none.winners, none.clearingPriceZat, none.refundsOwed.get("a")], [false, [], 0, 90]);
  // Equal amounts: the earlier block wins.
  assert.deepEqual(decide([b("x", 200, 9), b("y", 200, 3), b("z", 300)], rules).winners, ["z", "y"]);
});
