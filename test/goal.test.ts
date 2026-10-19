// Locked answers for the goal rule (all-or-nothing fundraisers and group buys).
// Written before the code. If the goal is reached every on-time payment is kept and nobody gets a
// refund; if it is missed every payment comes back in full. Late payments always come back in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot } from "../src/check.ts";
import { decide } from "../src/rules.ts";

const ex = (p: string) => JSON.parse(readFileSync(new URL(`../examples/${p}`, import.meta.url), "utf8"));
const run = (dir: string) => checkLot(ex(`${dir}/disclosure.json`), ex(`${dir}/result.json`));
const bid = (txid: string, amountZat: number, height = 10) => ({ txid, amountZat, height });

test("the goal rule: reached keeps everything, missed refunds everything", () => {
  const bids = [bid("a", 3_000_000), bid("b", 2_000_000), bid("c", 1_500_000)];
  const hit = decide(bids, { kind: "goal", goalZat: 6_500_000 });
  assert.equal(hit.reserveMet, true);
  assert.deepEqual([...hit.winners].sort(), ["a", "b", "c"]);
  assert.equal(hit.clearingPriceZat, 0);
  assert.deepEqual([...hit.refundsOwed.values()], [0, 0, 0]);
  const miss = decide(bids, { kind: "goal", goalZat: 6_500_001 });
  assert.equal(miss.reserveMet, false);
  assert.deepEqual(miss.winners, []);
  assert.equal(miss.refundsOwed.get("a"), 3_000_000);
  assert.equal(miss.refundsOwed.get("b"), 2_000_000);
  assert.equal(miss.refundsOwed.get("c"), 1_500_000);
  assert.equal(decide([], { kind: "goal", goalZat: 1 }).reserveMet, false);
});

test("the auction rule is untouched", () => {
  const out = decide([bid("a", 3_000_000), bid("b", 2_000_000), bid("c", 1_500_000)], { itemCount: 2, reserveZat: 1_000_000 });
  assert.equal(out.clearingPriceZat, 1_500_000);
});

test("honest goal rounds pass: goal reached, and goal missed", () => {
  for (const dir of ["goal-reached", "goal-missed"]) {
    const v = run(dir);
    assert.equal(v.result, "PASS", `${dir}: ${v.failed.join(",")}`);
    assert.ok(v.checks.some((c) => c.id === "goal-reached"), dir);
  }
});

test("each cheat on a goal round fails exactly the checks written down here", () => {
  const want: Record<string, string[]> = {
    "goal-broken/01-refund-to-a-contributor": ["refund-total", "result-consistent"],
    "goal-broken/02-says-goal-missed-when-reached": ["goal-reached", "reserve", "winners-and-price"],
    "goal-broken/03-goal-raised-after-the-fact": ["goal-reached", "refunds-paid", "reserve", "result-consistent", "winners-and-price"],
    "goal-broken/04-says-goal-reached-when-missed": ["goal-reached", "reserve", "winners-and-price"],
  };
  for (const [dir, ids] of Object.entries(want)) {
    const v = run(dir);
    assert.equal(v.result, "FAIL", dir);
    assert.deepEqual([...v.failed].sort(), ids, dir);
  }
});

test("a goal file with a bad goal is refused with a plain message", () => {
  const d = ex("goal-reached/disclosure.json");
  d.rules.goalZat = 0;
  assert.throws(() => checkLot(d, ex("goal-reached/result.json")), /goal/i);
  const e = ex("goal-reached/disclosure.json");
  e.rules.kind = "raffle";
  assert.throws(() => checkLot(e, ex("goal-reached/result.json")), /rules/i);
});
