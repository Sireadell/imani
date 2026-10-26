// Locked answers for published totals. Written before the example round.
//   totals-01 passes every check, including the two totals checks (basic and against the chain).
//   Each broken copy fails exactly the checks named in its manifest.
//   A result file without totals is judged exactly as before (the plain-verdicts snapshot guards this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot } from "../src/check.ts";

const rd = (p: string) => JSON.parse(readFileSync(new URL(`../examples/${p}`, import.meta.url), "utf8"));

test("totals-01 passes and both totals checks ran", () => {
  const v = checkLot(rd("totals-01/disclosure.json"), rd("totals-01/result.json"));
  assert.equal(v.result, "PASS", v.failed.join(", "));
  for (const id of ["published-totals", "published-totals-chain"]) assert.equal(v.checks.find((c) => c.id === id)?.status, "PASS", id);
  assert.match(v.checks.find((c) => c.id === "published-totals-chain")!.reason, /4 payments, 7,700,000 zat received, 4,700,000 zat refunded and 3,000,000 zat kept/);
});

test("a round without totals gets no totals checks", () => {
  const v = checkLot(rd("round-01/disclosure.json"), rd("round-01/result.json"));
  assert.equal(v.checks.some((c) => c.id.startsWith("published-totals")), false);
});

test("each broken copy of totals-01 fails exactly the checks its manifest names", () => {
  const m = rd("totals-broken/manifest.json");
  assert.equal(m.copies.length, 4);
  for (const c of m.copies) {
    const v = checkLot(rd(`totals-broken/${c.name}/disclosure.json`), rd(`totals-broken/${c.name}/result.json`));
    assert.equal(v.result, "FAIL", c.name);
    assert.deepEqual([...v.failed].sort(), [...c.expectedFailingChecks].sort(), c.name);
  }
});

test("a totals block with a missing or negative number is refused before any check runs", () => {
  const d = rd("totals-01/disclosure.json");
  for (const bad of [{ payments: 4, receivedZat: 1, keptZat: 1 }, { payments: -1, receivedZat: 1, keptZat: 1, refundedZat: 1 }, { payments: 4.5, receivedZat: 1, keptZat: 1, refundedZat: 1 }]) {
    const r = rd("totals-01/result.json");
    r.totals = bad;
    assert.throws(() => checkLot(d, r), /totals in the result file needs/);
  }
});
