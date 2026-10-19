import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllowlist, scanFile, scanHistory, scanRepo } from "../tools/leak-scan.ts";

// Built at run time so this file holds nothing key-shaped.
const VIEW = "uviewtest1" + "canarysecret".repeat(5);
const MAIN_VIEW = "uview1" + "canarysecret".repeat(5);
const SPEND = "secret-extended-key-main1" + "canarysecret".repeat(5);
const SEED = "abandon ".repeat(11) + "about";

test("the repo scan finds each kind of secret and a .env file", () => {
  assert.deepEqual(scanFile("a.json", `{"k":"${VIEW}"}`, []).map((f) => f.problem), ["line 1 holds something shaped like a viewing key"]);
  assert.match(scanFile("a.md", `x\n${MAIN_VIEW}`, [])[0].problem, /line 2 .* viewing key/);
  assert.match(scanFile("a.ts", `const k = "${SPEND}";`, [])[0].problem, /spending key/);
  assert.match(scanFile("a.txt", `my seed: ${SEED}`, [])[0].problem, /seed phrase/);
  assert.match(scanFile(".env", "A=1", [])[0].problem, /\.env/);
  assert.match(scanFile("deploy/.env.production", "A=1", [])[0].problem, /\.env/);
  assert.deepEqual(scanFile(".env.example", "A=", []), []);
  assert.deepEqual(scanFile("README.md", "Plain prose is fine, even a long sentence about nothing in particular here.", []), []);
});

test("a finding never repeats the secret", () => {
  for (const s of [VIEW, SPEND, SEED]) assert.ok(!JSON.stringify(scanFile("a", s, [])).includes(s.slice(0, 30)));
});

test("allowlisted files may hold a public test key, but never a spending key's .env", () => {
  const allow = [{ path: "examples/", reason: "Throwaway test keys, published on purpose." }];
  assert.deepEqual(scanFile("examples/x/disclosure.json", VIEW, allow), []);
  assert.equal(scanFile("src/x.ts", VIEW, allow).length, 1);
  assert.equal(scanFile("examples/.env", "A=1", allow).length, 1);
});

test("the allowlist file needs a reason for every entry and the repo is clean", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const list = loadAllowlist(join(root, "tools/leak-scan.allow.json"));
  assert.ok(list.length > 0 && list.every((e) => e.reason.length >= 10));
  assert.deepEqual(scanRepo(root, list), []);
});

test("scanRepo reads only tracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-scan-"));
  try {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/ok.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/bad.ts"), `const k = "${VIEW}";\n`);
    writeFileSync(join(dir, "untracked.txt"), VIEW);
    git("add", "src");
    assert.deepEqual(scanRepo(dir, []), [{ file: "src/bad.ts", problem: "line 1 holds something shaped like a viewing key" }]);
    assert.deepEqual(scanRepo(dir, [{ path: "src/bad.ts", reason: "A public test key for this test." }]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// History scan. Answers locked 2026-10-19 before the code was written: a key committed and then
// deleted is clean in the current files but found in history, named by commit and path; an
// allowlisted path stays allowed in history; a clean history gives no finding.
test("scanHistory finds a key that was committed and later deleted, and names the commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-hist-"));
  try {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/ok.ts"), "export const a = 1;\n");
    git("add", "src");
    git("commit", "-q", "-m", "one");
    assert.deepEqual(scanHistory(dir, []), []);
    writeFileSync(join(dir, "src/bad.ts"), `const k = "${SPEND}";\n`);
    git("add", "src");
    git("commit", "-q", "-m", "two");
    const bad = git("rev-parse", "--short", "HEAD").trim();
    rmSync(join(dir, "src/bad.ts"));
    git("add", "-u");
    git("commit", "-q", "-m", "three");
    assert.deepEqual(scanRepo(dir, []), []);
    const found = scanHistory(dir, []);
    assert.equal(found.length, 1);
    assert.equal(found[0].file, "src/bad.ts");
    assert.match(found[0].problem, /spending key/);
    assert.match(found[0].problem, new RegExp(`commit ${bad}`));
    assert.ok(!JSON.stringify(found).includes(SPEND.slice(0, 30)));
    assert.deepEqual(scanHistory(dir, [{ path: "src/bad.ts", reason: "A public test key for this test." }]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
