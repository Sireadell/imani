// The page gives the same answers as the command line checker for the goal rounds.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkLot } from "../../src/check.ts";
import { buildEngine } from "../../tools/site-build.ts";

const tmp = mkdtempSync(join(tmpdir(), "imani-goal-page-"));
let engine: any;
before(async () => {
  await buildEngine(join(tmp, "engine.mjs"));
  engine = await import(pathToFileURL(join(tmp, "engine.mjs")).href);
  await engine.initReader();
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const ex = (p: string) => JSON.parse(readFileSync(new URL(`../../examples/${p}`, import.meta.url), "utf8"));

test("page logic equals the checker for both honest goal rounds and all four cheats", () => {
  const dirs = ["goal-reached", "goal-missed", ...ex("goal-broken/manifest.json").copies.map((c: any) => `goal-broken/${c.name}`)];
  assert.equal(dirs.length, 6);
  for (const dir of dirs) {
    const d = ex(`${dir}/disclosure.json`);
    const r = ex(`${dir}/result.json`);
    const out = engine.runPage({ disclosure: d, result: r });
    assert.equal(out.ok, true, dir);
    assert.deepEqual(out.verdict, checkLot(d, r), dir);
    assert.equal(out.verdict.result, dir.includes("broken") ? "FAIL" : "PASS", dir);
  }
});
