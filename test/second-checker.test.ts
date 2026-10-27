// The second checker is a separate, small program written in Python that re-derives the winners,
// the price and the refund amounts from the plain numbers in the round files. These tests run it
// against the conformance manifest and against one doctored copy of a round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return cmd;
  }
  return null;
}

const python = findPython();
const skip = python ? false : "Python 3 is not installed (tried python3 and python), so the second checker cannot run here";
const script = "tools/second-checker/check.py";

test("second checker: agrees with the manifest on every case it can decide, and says how many that is", { skip }, () => {
  const r = spawnSync(python!, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /decided (\d+) of 52, agrees on all (\d+); the other (\d+) need the payment reader/.exec(r.stdout);
  assert.ok(m, "summary line missing:\n" + r.stdout);
  const [decided, agreed, rest] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.equal(decided, agreed);
  assert.equal(decided + rest, 52);
  assert.ok(decided >= 10, "it should at least decide the honest rounds");
  assert.doesNotMatch(r.stdout, /DISAGREE/);
});

test("second checker: a doctored price in a copy of round-01 is caught", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "second-checker-"));
  cpSync("examples/round-01", dir, { recursive: true });
  const resultPath = join(dir, "result.json");
  const ok = spawnSync(python!, [script, "--files", join(dir, "disclosure.json"), resultPath], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.clearingPriceZat += 100000;
  writeFileSync(resultPath, JSON.stringify(result));
  const bad = spawnSync(python!, [script, "--files", join(dir, "disclosure.json"), resultPath], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /FAIL/);
  assert.match(bad.stdout, /winners-and-price/);
});
