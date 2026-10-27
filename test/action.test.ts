import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const action = read("action.yml");
const doc = read("docs/GITHUB_ACTION.md");

// Input names declared under the top-level "inputs:" block of action.yml.
function inputNames(): string[] {
  const block = action.split(/^inputs:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
  return [...block.matchAll(/^  ([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
}

test("action.yml is a composite action with the four inputs", () => {
  assert.match(action, /using:\s*composite/);
  assert.deepEqual(inputNames(), ["disclosure", "result", "scan", "chain"]);
  assert.match(action, /bin\/imani\.js/);
  assert.match(action, /github\.action_path/);
});

test("the doc's usage text names every input and no other", () => {
  const usage = doc.split("```yaml")[1]?.split("```")[0] ?? "";
  assert.match(usage, /uses:/);
  const withKeys = [...usage.matchAll(/^\s{6,}([a-z][a-z-]*):/gm)].map((m) => m[1]);
  for (const k of withKeys) assert.ok(inputNames().includes(k), `doc uses unknown input ${k}`);
  for (const n of inputNames()) assert.ok(doc.includes(`\`${n}\``), `doc table is missing ${n}`);
});

test("the doc opens with the agreed paragraph and avoids banned words", () => {
  assert.ok(doc.includes("If you publish auction results from a GitHub repository, this action checks them on every push. It runs the same check as the command line on your round's two files, and the build goes red when the round doesn't add up: a bid missing, a refund short, the wrong winner. Nothing is sent to us. The check runs inside your own workflow."));
  for (const text of [doc, action]) {
    assert.ok(!text.includes("—"));
    assert.ok(!/trustless/i.test(text));
    assert.ok(!/\bfirst\b/i.test(text));
  }
  assert.match(doc, /public/);
  assert.ok(!/marketplace/i.test(doc.replace(/not (listed|published)[^.]*marketplace[^.]*\./i, "")));
});

const run = (dir: string) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/imani.js", "check", "--disclosure", `${dir}/disclosure.json`, "--result", `${dir}/result.json`], { encoding: "utf8" });

test("the honest testnet round passes with the command the action runs", () => {
  const r = run("examples/testnet-01");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /RESULT: PASS/);
});

test("the round with a hidden losing bid fails with the same command", () => {
  const r = run("examples/testnet-broken/01-hidden-losing-bid");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /RESULT: FAIL/);
});

test("scan mode with a chain file passes on the honest round", () => {
  const d = "examples/testnet-01";
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/imani.js", "check", "--disclosure", `${d}/disclosure.json`, "--result", `${d}/result.json`, "--scan", "--chain", `${d}/chain.json`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("action.yml installs the packages before it runs the checker", () => {
  const install = action.indexOf("npm ci");
  const run = action.indexOf("bin/imani.js");
  assert.ok(install > 0, "action.yml has no npm ci step");
  assert.ok(install < run, "npm ci must come before the checker runs");
  assert.match(action, /working-directory:\s*\${{ github\.action_path }}/);
});

test("the self-test workflow runs only on main pushes and pull requests into main", () => {
  const wf = read(".github/workflows/action-selftest.yml");
  assert.match(wf, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(wf, /pull_request:\s*\n\s+branches:\s*\[main\]/);
});
