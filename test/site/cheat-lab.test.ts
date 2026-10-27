import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEngine, exampleData } from "../../tools/site-build.ts";
import { CHEATS, caughtLine, RESET_LABEL } from "../../src/site/cheat-lab.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "imani-cheat-"));
let engine: any;
let data: ReturnType<typeof exampleData>;

before(async () => {
  await buildEngine(join(tmp, "engine.mjs"));
  engine = await import(pathToFileURL(join(tmp, "engine.mjs")).href);
  await engine.initReader();
  data = exampleData();
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function runExample(id: string) {
  const e = data.entries.find((x) => x.id === id);
  assert.ok(e, `example ${id} exists in the page's list`);
  const out = engine.runPage({
    disclosure: JSON.parse(data.blobs[e.disclosure]),
    result: JSON.parse(data.blobs[e.result]),
    chain: e.chain ? JSON.parse(data.blobs[e.chain]) : undefined,
    chainLabel: e.chain ? "chain.json" : undefined,
  });
  assert.equal(out.ok, true);
  return { entry: e, verdict: out.verdict };
}

test("there are three cheats with the agreed ids", () => {
  assert.deepEqual(CHEATS.map((c) => c.exampleId), [
    "testnet-broken/01-hidden-losing-bid",
    "broken/04-short-refund",
    "pricing-broken/04-leaves-out-the-lowest-winner",
  ]);
});

test("each cheat fails with exactly the checks its example promises", () => {
  for (const c of CHEATS) {
    const { entry, verdict } = runExample(c.exampleId);
    assert.equal(verdict.result, "FAIL", c.exampleId);
    const want = entry.expectedFailingChecks ?? [entry.expectedFailingCheck];
    assert.deepEqual([...verdict.failed].sort(), [...want].sort(), c.exampleId);
  }
});

test("the honest round passes", () => {
  const { verdict } = runExample("testnet-01");
  assert.equal(verdict.result, "PASS");
  assert.equal(caughtLine(CHEATS[0], verdict), null);
});

test("the caught line takes its names from the verdict only", () => {
  const fake = { result: "FAIL", failed: ["alpha-check", "beta-check"] } as any;
  assert.equal(caughtLine(CHEATS[1], fake), "Caught. The chain shows Carol was paid 100,000 short (alpha-check, beta-check).");
  for (const c of CHEATS) {
    const { verdict } = runExample(c.exampleId);
    const line = caughtLine(c, verdict)!;
    assert.ok(line.includes(`(${verdict.failed.join(", ")})`));
    assert.ok(!line.includes("{"));
  }
  assert.equal(caughtLine(CHEATS[0], { result: "FAIL", failed: [] } as any), null);
});

test("the panel markup has the agreed words and nothing risky", () => {
  const html = rd("src/site/cheat-lab.html");
  for (const t of ["Cheat lab", "Pick a cheat. The page changes one fact in the seller's files and runs the same check again.", RESET_LABEL, "Each cheat is a real file from our test kit. Your own copy of Imani fails it the same way."]) assert.ok(html.includes(t), t);
  for (const c of CHEATS) {
    assert.ok(html.includes(`>${c.label}<`), c.label);
    assert.ok(html.includes(c.line), c.line);
    assert.ok(html.includes(`data-cheat="${c.exampleId}"`), c.exampleId);
  }
  assert.ok(html.includes('<section id="cheat-lab"'));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:|www\./i);
  assert.ok(!html.includes("—"));
  assert.doesNotMatch(html, /trustless|\bfirst\b/i);
  assert.doesNotMatch(rd("src/site/cheat-lab.ts"), /—|trustless|\bfirst\b/i);
});

test("the home page holds the cheat lab panel and app.ts mounts it", () => {
  const html = rd("src/site/static/index.html");
  assert.equal((html.match(/id="cheat-lab"/g) ?? []).length, 1);
  for (const c of CHEATS) assert.ok(html.includes(`data-cheat="${c.exampleId}"`), c.exampleId);
  assert.equal((html.match(/<a href="check\.html">Check any round<\/a>/g) ?? []).length, 1);
  const app = rd("src/site/app.ts");
  assert.match(app, /import \{ mountCheatLab \} from "\.\/cheat-lab\.ts"/);
  assert.match(app, /mountCheatLab\(labRoot/);
});
