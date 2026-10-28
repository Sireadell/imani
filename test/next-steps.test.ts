// "What to do next": plain advice printed under a FAIL, and nothing on a PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextStepsText } from "../src/next-steps.ts";
import { run } from "../src/cli.ts";

const ex = (p: string) => fileURLToPath(new URL(`../examples/${p}`, import.meta.url));

test("no failed checks gives no advice", () => {
  assert.deepEqual(nextStepsText([]), []);
});

test("an unknown check id still gets a line", () => {
  const t = nextStepsText(["made-up-check"]);
  assert.match(t.join("\n"), /made-up-check: Ask the seller about this check by name/);
});

test("a failed refund check tells a bidder to run bidder-check", () => {
  const r = run(["check", "--disclosure", ex("broken/03-missing-refund/disclosure.json"), "--result", ex("broken/03-missing-refund/result.json")]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /What to do next\n {2}refunds-paid: .*imani bidder-check/);
  assert.match(r.stdout, /RESULT: FAIL \(1 of 15 checks failed: refunds-paid\)\s*$/);
});

test("a passing round prints no advice", () => {
  const r = run(["check", "--disclosure", ex("testnet-01/disclosure.json"), "--result", ex("testnet-01/result.json"), "--offline"]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /What to do next/);
});

test("every broken example names its failed check with its own advice, not the fallback", () => {
  for (const dir of readdirSync(ex("broken"))) {
    const r = run(["check", "--disclosure", ex(`broken/${dir}/disclosure.json`), "--result", ex(`broken/${dir}/result.json`)]);
    if (r.code !== 1) continue;
    assert.doesNotMatch(r.stdout, /Ask the seller about this check by name/, dir);
  }
});
