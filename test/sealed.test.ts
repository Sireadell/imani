// Sealed lots: the seal hash, the memo parsers and the opening rules.
// Answers below were worked by hand from docs/SELLER_BLIND_PLAN.md before the code was written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemoPrefix, parseOpenMemo, parseSealMemo, sealHash, sealMemoPrefix, type SealedRules } from "../src/files.ts";
import { writeFileSync } from "node:fs";
import { openSeals, type OpenFact, type SealFact } from "../src/sealed.ts";

const LOT = "LOT-01";
const SALT = "00112233445566778899aabbccddeeff";
const HASH = "66e3c5f9b740d2fd3d7a1e927a04517526773bf731cb054338c055291151e762";

test("sealHash on the fixed vector (lot LOT-01, word q7k2, 3000000, salt 0011..eeff, no address)", () => {
  // Computed once with node:crypto sha256 over "imani-seal/1|LOT-01|q7k2|3000000|<salt>|" and pasted here.
  assert.equal(sealHash(LOT, "q7k2", 3_000_000, SALT), HASH);
  assert.equal(sealHash(LOT, "q7k2", 3_000_000, SALT, null), HASH);
  assert.notEqual(sealHash(LOT, "q7k2", 3_000_000, SALT, "utest1x"), HASH);
  assert.notEqual(sealHash(LOT, "q7k2", 3_000_001, SALT), HASH);
});

test("memo parsers accept the good forms", () => {
  assert.deepEqual(parseSealMemo(LOT, `seal:${LOT}:q7k2:${HASH}`), { word: "q7k2", hash: HASH, address: null });
  assert.deepEqual(parseSealMemo(LOT, `seal:${LOT}:q7k2:${HASH}:utest1abc`), { word: "q7k2", hash: HASH, address: "utest1abc" });
  assert.deepEqual(parseOpenMemo(LOT, `open:${LOT}:q7k2:3000000:${SALT}`), { word: "q7k2", amountZat: 3_000_000, salt: SALT });
  assert.equal(sealMemoPrefix(LOT), "seal:LOT-01:");
  assert.equal(openMemoPrefix(LOT), "open:LOT-01:");
});

test("memo parsers reject bad forms", () => {
  assert.equal(parseSealMemo(LOT, `seal:${LOT}:q7k2:${HASH.toUpperCase()}`), null, "upper-case hash");
  assert.equal(parseSealMemo(LOT, `seal:${LOT}:q7k2:${HASH.slice(0, 63)}`), null, "63-char hash");
  assert.equal(parseSealMemo(LOT, `seal:${LOT}:q7k2:${HASH}:`), null, "empty address");
  assert.equal(parseSealMemo(LOT, `seal:${LOT}:${HASH}`), null, "no word");
  assert.equal(parseSealMemo("LOT-02", `seal:${LOT}:q7k2:${HASH}`), null, "wrong lot");
  assert.equal(parseOpenMemo(LOT, `open:${LOT}:q7k2:007:${SALT}`), null, "leading zeros");
  assert.equal(parseOpenMemo(LOT, `open:${LOT}:q7k2:-5:${SALT}`), null, "negative");
  assert.equal(parseOpenMemo(LOT, `open:${LOT}:q7k2:3000000:${SALT.slice(0, 31)}`), null, "31-char salt");
  assert.equal(parseOpenMemo(LOT, `open:${LOT}:q7k2:3000000:${SALT.toUpperCase()}`), null, "upper-case salt");
  assert.equal(parseOpenMemo("LOT-02", `open:${LOT}:q7k2:3000000:${SALT}`), null, "wrong lot");
});

// ---- Facts for the opening rules ----
const RULES: SealedRules = { kind: "sealed", itemCount: 2, reserveZat: 1_000_000, depositZat: 5_000_000, forfeitZat: 500_000 };
const CLOSE = 100;
const OPEN_BY = 200;
const id = (n: number) => n.toString(16).padStart(64, "0");
const saltOf = (n: number) => n.toString(16).padStart(32, "0");

/** A seal for word w<n> sealed at `price`, paid at `height` with `paid`. */
function seal(n: number, price: number, o: Partial<SealFact> = {}): SealFact {
  const word = `w${n}`;
  return { txid: id(n), height: 10 + n, paidZat: RULES.depositZat, valid: true, word, hash: sealHash(LOT, word, price, saltOf(n), null), address: null, ...o };
}
/** The matching opening, txid 100+n, opening the price `claim` (default the sealed price). */
function opening(n: number, claim: number, o: Partial<OpenFact> = {}): OpenFact {
  return { txid: id(100 + n), height: 120 + n, paidZat: 10_000, valid: true, word: `w${n}`, amountZat: claim, salt: saltOf(n), ...o };
}

test("openSeals: 3 counted, 1 unopened, 1 bad opening, refunds match the hand-worked table", () => {
  // Prices: 1 -> 3,000,000  2 -> 2,000,000  3 -> 1,500,000. Seal 4 never opened. Seal 5 sealed 900,000 and opens 800,000.
  const seals = [seal(1, 3_000_000), seal(2, 2_000_000), seal(3, 1_500_000), seal(4, 1_200_000), seal(5, 900_000)];
  const openings = [opening(1, 3_000_000), opening(2, 2_000_000), opening(3, 1_500_000), opening(5, 800_000)];
  const o = openSeals(LOT, RULES, CLOSE, OPEN_BY, seals, openings);
  assert.equal(o.counted.length, 3);
  assert.equal(o.unopened.length, 1);
  assert.equal(o.badOpen.length, 1);
  assert.deepEqual(o.outcome.winners.sort(), [id(1), id(2)]);
  assert.equal(o.outcome.clearingPriceZat, 1_500_000);
  // Penalties: 2 x 500,000 = 1,000,000 over 3 counted bids = 333,333 each, 1 left over to the lowest seal txid (seal 1).
  assert.equal(o.penaltyTotal, 1_000_000);
  assert.equal(o.share, 333_333);
  assert.equal(o.leftover, 1);
  assert.equal(o.leftoverTo, id(1));
  assert.equal(o.owed.get(id(1)), 5_000_000 - 1_500_000 + 10_000 + 333_333 + 1); // 3,843,334 winner
  assert.equal(o.owed.get(id(2)), 5_000_000 - 1_500_000 + 10_000 + 333_333); // 3,843,333 winner
  assert.equal(o.owed.get(id(3)), 5_000_000 + 10_000 + 333_333); // 5,343,333 loser
  assert.equal(o.owed.get(id(4)), 5_000_000 - 500_000); // 4,500,000 unopened
  assert.equal(o.owed.get(id(5)), 5_000_000 - 500_000 + 10_000); // 4,510,000 bad opening, opening payment returned
  assert.equal(o.reasons.get(id(1)), "change");
  assert.equal(o.reasons.get(id(3)), "loser");
  assert.equal(o.reasons.get(id(4)), "unopened");
  assert.equal(o.reasons.get(id(5)), "bad-opening");
  // Money check: everything paid in = refunds + clearing price x winners.
  const paidIn = 5 * 5_000_000 + 4 * 10_000;
  const refunds = [...o.owed.values()].reduce((s, a) => s + a, 0);
  assert.equal(refunds + 1_500_000 * 2, paidIn);
});

test("rounding: 3 penalties across 2 counted bids split evenly, and a 1 zatoshi leftover goes to the lowest seal txid", () => {
  const even = openSeals(LOT, RULES, CLOSE, OPEN_BY,
    [seal(1, 3_000_000), seal(2, 2_000_000), seal(3, 1_000_000), seal(4, 1_000_000), seal(5, 1_000_000)],
    [opening(1, 3_000_000), opening(2, 2_000_000)]);
  assert.equal(even.penaltyTotal, 1_500_000);
  assert.equal(even.share, 750_000);
  assert.equal(even.leftover, 0);

  const odd = openSeals(LOT, { ...RULES, forfeitZat: 500_001 }, CLOSE, OPEN_BY,
    [seal(7, 3_000_000), seal(2, 2_000_000), seal(3, 1_000_000)],
    [opening(7, 3_000_000), opening(2, 2_000_000)]);
  assert.equal(odd.penaltyTotal, 500_001);
  assert.equal(odd.share, 250_000);
  assert.equal(odd.leftover, 1);
  assert.equal(odd.leftoverTo, id(2), "seal 2 has the lower txid of the two counted");
  // Both win at the reserve 1,000,000: 5,000,000 - 1,000,000 + 10,000 + 250,000 + 1.
  assert.equal(odd.owed.get(id(2)), 4_260_001);
  assert.equal(odd.owed.get(id(7)), 4_260_000);
});

test("no counted bids: nobody pays a penalty, every seal comes back in full plus its opening", () => {
  const o = openSeals(LOT, RULES, CLOSE, OPEN_BY, [seal(1, 900_000), seal(2, 800_000)], [opening(1, 700_000)]);
  assert.equal(o.counted.length, 0);
  assert.equal(o.penaltyTotal, 0);
  assert.equal(o.owed.get(id(1)), 5_000_000 + 10_000, "wrong opening, no penalty because nobody opened correctly");
  assert.equal(o.owed.get(id(2)), 5_000_000);
});

test("openings that cannot count: above the deposit, zero, too early, too late; the penalty applies", () => {
  const good = [seal(1, 3_000_000)];
  const base = (extra: OpenFact[], extraSeals: SealFact[]) =>
    openSeals(LOT, RULES, CLOSE, OPEN_BY, [...good, ...extraSeals], [opening(1, 3_000_000), ...extra]);
  // Amount above the deposit: the hash matches a sealed 5,000,001 but the price is out of range.
  const big: SealFact = { ...seal(2, 5_000_001) };
  let o = base([opening(2, 5_000_001)], [big]);
  assert.deepEqual(o.badOpen.map((s) => s.txid), [id(2)]);
  assert.equal(o.owed.get(id(2)), 5_000_000 - 500_000 + 10_000);
  // Amount 0.
  const zero = seal(3, 0);
  o = base([opening(3, 0)], [zero]);
  assert.deepEqual(o.badOpen.map((s) => s.txid), [id(3)]);
  // Opening at closeHeight: too early, so it is a stray payment and the seal is unopened.
  o = base([opening(4, 1_000_000, { height: CLOSE })], [seal(4, 1_000_000)]);
  assert.deepEqual(o.unopened.map((s) => s.txid), [id(4)]);
  assert.deepEqual(o.strayOpenings.map((x) => x.txid), [id(104)]);
  assert.equal(o.owed.get(id(104)), 10_000, "the stray opening is refunded in full under its own id");
  assert.equal(o.owed.get(id(4)), 4_500_000);
  // Opening at openByHeight + 1: too late.
  o = base([opening(5, 1_000_000, { height: OPEN_BY + 1 })], [seal(5, 1_000_000)]);
  assert.deepEqual(o.unopened.map((s) => s.txid), [id(5)]);
  // Opening at exactly openByHeight still counts.
  o = base([opening(6, 1_000_000, { height: OPEN_BY })], [seal(6, 1_000_000)]);
  assert.equal(o.counted.length, 2);
});

test("two openings for one word: the first counts, the second is a replay refunded in full", () => {
  const o = openSeals(LOT, RULES, CLOSE, OPEN_BY, [seal(1, 3_000_000)], [opening(1, 3_000_000), opening(1, 3_000_000, { txid: id(901), height: 150 })]);
  assert.equal(o.counted.length, 1);
  assert.deepEqual(o.replayedOpenings.map((x) => x.txid), [id(901)]);
  assert.equal(o.owed.get(id(901)), 10_000);
  assert.equal(o.reasons.get(id(901)), "opening");
});

test("seal problems: wrong deposit, late seal and repeated word are refunded in full and never count", () => {
  const o = openSeals(LOT, RULES, CLOSE, OPEN_BY,
    [seal(1, 3_000_000), seal(2, 2_000_000, { paidZat: 4_999_999 }), seal(3, 2_000_000, { height: CLOSE + 1 }), seal(4, 2_000_000, { word: "w1", hash: seal(1, 3_000_000).hash })],
    [opening(1, 3_000_000), opening(2, 2_000_000), opening(3, 2_000_000)]);
  assert.equal(o.counted.length, 1);
  assert.deepEqual(o.badDeposit.map((s) => s.txid), [id(2)]);
  assert.deepEqual(o.lateSeals.map((s) => s.txid), [id(3)]);
  assert.deepEqual(o.replayedSeals.map((s) => s.txid), [id(4)]);
  assert.equal(o.owed.get(id(2)), 4_999_999);
  assert.equal(o.owed.get(id(3)), 5_000_000);
  assert.equal(o.owed.get(id(4)), 5_000_000);
  // Their openings do not belong to any counted seal: refunded in full on their own.
  assert.equal(o.owed.get(id(102)), 10_000);
  assert.equal(o.owed.get(id(103)), 10_000);
  // No penalties for any of them.
  assert.equal(o.penaltyTotal, 0);
});

test("a seal with a refund address in its memo needs the address in the hash", () => {
  const addr = "utest1abcdef";
  const s = seal(1, 3_000_000, { address: addr, hash: sealHash(LOT, "w1", 3_000_000, saltOf(1), addr) });
  assert.equal(openSeals(LOT, RULES, CLOSE, OPEN_BY, [s], [opening(1, 3_000_000)]).counted.length, 1);
  const wrong = { ...s, address: "utest1other" };
  assert.equal(openSeals(LOT, RULES, CLOSE, OPEN_BY, [wrong], [opening(1, 3_000_000)]).badOpen.length, 1);
});

// ---- Command line: imani seal and imani open ----
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { checkLot } from "../src/check.ts";
import { toText } from "../src/report.ts";

test("imani seal then imani open round-trip: the hash recomputes and no server is contacted", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-seal-"));
  try {
    const s = run(["seal", "--lot", LOT, "--amount", "3000000", "--address", "utest1abcdef", "--deposit", "5000000", "--out", dir]);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /Servers contacted: none/);
    const memo = s.stdout.split("\n").find((l) => l.startsWith("seal:"))!;
    const parsed = parseSealMemo(LOT, memo)!;
    assert.ok(parsed);
    const file = join(dir, `seal-${parsed.word}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(rec.amountZat, 3_000_000);
    assert.equal(parsed.address, "utest1abcdef");
    assert.equal(parsed.hash, sealHash(LOT, parsed.word, 3_000_000, rec.salt, "utest1abcdef"));
    const o = run(["open", "--file", file]);
    assert.equal(o.code, 0, o.stderr);
    assert.match(o.stdout, /Servers contacted: none/);
    const openMemo = o.stdout.split("\n").find((l) => l.startsWith("open:"))!;
    assert.deepEqual(parseOpenMemo(LOT, openMemo), { word: parsed.word, amountZat: 3_000_000, salt: rec.salt });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("imani seal refuses a price above the deposit, a bad amount and a missing lot", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-seal-"));
  try {
    assert.equal(run(["seal", "--lot", LOT, "--amount", "5000001", "--deposit", "5000000", "--out", dir]).code, 2);
    assert.match(run(["seal", "--lot", LOT, "--amount", "5000001", "--deposit", "5000000", "--out", dir]).stderr, /higher than the lot's deposit/);
    assert.equal(run(["seal", "--lot", LOT, "--amount", "007", "--out", dir]).code, 2);
    assert.equal(run(["seal", "--amount", "5", "--out", dir]).code, 2);
    assert.equal(run(["open", "--file", join(dir, "missing.json")]).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seal file made by hand with a price that does not match its memo is not opened", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-seal-"));
  try {
    const s = run(["seal", "--lot", LOT, "--amount", "3000000", "--word", "ab12", "--out", dir]);
    const file = join(dir, "seal-ab12.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.amountZat = 3_000_001;
    writeFileSync(file, JSON.stringify(rec));
    assert.equal(s.code, 0);
    assert.equal(run(["open", "--file", file]).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The seal file's salt never reaches a --discreet verdict ----
test("sealed-01 --discreet: no salt, price, seal hash or refund address of the round appears in the verdict", () => {
  const vec = JSON.parse(readFileSync(new URL("./vectors/sealed-round.json", import.meta.url), "utf8"));
  const d = JSON.parse(readFileSync(new URL("../examples/sealed-01/disclosure.json", import.meta.url), "utf8"));
  const r = JSON.parse(readFileSync(new URL("../examples/sealed-01/result.json", import.meta.url), "utf8"));
  const text = JSON.stringify(checkLot(d, r, { discreet: true })) + toText(checkLot(d, r, { discreet: true }));
  const secrets: string[] = [];
  for (const t of Object.values(vec.transactions) as any[]) {
    for (const out of t.outputs) {
      const m = parseOpenMemo(LOT, out.memo);
      if (m) secrets.push(m.salt);
      const sm = parseSealMemo(LOT, out.memo);
      if (sm) secrets.push(sm.hash);
      if (sm?.address) secrets.push(sm.address);
    }
  }
  assert.ok(secrets.length >= 10);
  for (const x of secrets) assert.ok(!text.includes(x), `${x.slice(0, 12)} leaked`);
  for (const a of ["3,000,000 zat", "5,000,000 zat", "1,500,000 zat"]) assert.ok(!text.includes(a), a);
});
