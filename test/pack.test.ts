import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The installed package must run on its own: Node will not run .ts files inside node_modules,
// so the package ships a bundled dist/. This installs the real tarball in an empty folder
// (no network needed: the package has no dependencies) and runs it, within the 120 second
// budget the plan sets for a clean-machine install.
const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", shell: cmd === npm && process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });

test("the packed tarball installs in an empty folder and checks a lot, within 120 seconds", () => {
  const started = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "imani-pack-"));
  try {
    sh(npm, ["pack", "--pack-destination", tmp, "--silent"], root);
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"))!;
    const app = join(tmp, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), "{}");
    sh(npm, ["install", "--silent", "--no-audit", "--no-fund", join(tmp, tgz)], app);
    const ex = (p: string) => join(app, "node_modules", "imani", "examples", p);
    const bin = join(app, "node_modules", "imani", "bin", "imani.js");
    const honest = sh("node", [bin, "check", "--disclosure", ex("round-01/disclosure.json"), "--result", ex("round-01/result.json"), "--mine", "d928588fc1"], app);
    assert.match(honest, /RESULT: PASS \(15 of 15 checks passed\)/);
    assert.match(honest, /Your bid: counted/);
    let failed = "";
    try {
      sh("node", [bin, "check", "--disclosure", ex("broken/04-short-refund/disclosure.json"), "--result", ex("broken/04-short-refund/result.json")], app);
    } catch (e: any) {
      failed = String(e.stdout);
      assert.equal(e.status, 1);
    }
    assert.match(failed, /RESULT: FAIL \(1 of 15 checks failed: refunds-paid\)/);
    writeFileSync(join(app, "login-check.mjs"), 'import { LoginKit } from "imani/login"; console.log(typeof LoginKit);');
    const login = sh("node", ["login-check.mjs"], app);
    assert.match(login, /function/);
    // The checker is importable by package name, and a broken copy fails through the same call.
    const lib = [
      'import { readFileSync } from "node:fs";',
      'import { checkLot, makeBidLink, decide } from "imani";',
      'const read = (p) => JSON.parse(readFileSync(p, "utf8"));',
      `const dir = ${JSON.stringify(ex("round-01"))};`,
      'const v = checkLot(read(dir + "/disclosure.json"), read(dir + "/result.json"));',
      `const bad = checkLot(read(${JSON.stringify(ex("broken/04-short-refund/disclosure.json"))}), read(${JSON.stringify(ex("broken/04-short-refund/result.json"))}));`,
      'console.log(v.result, v.checks.length, bad.result, bad.failed.join(","), typeof makeBidLink, typeof decide);',
    ].join(String.fromCharCode(10));
    writeFileSync(join(app, "lib-check.mjs"), lib);
    assert.equal(sh("node", ["lib-check.mjs"], app).trim(), "PASS 15 FAIL refunds-paid function function");
    assert.ok(readdirSync(join(app, "node_modules", "imani", "dist", "types")).includes("index.d.ts"));
    // TypeScript users get types for imani/login from the installed package.
    assert.ok(readdirSync(join(app, "node_modules", "imani", "dist", "types", "login")).includes("index.d.ts"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(Date.now() - started < 120_000, "install and first check took longer than 120 seconds");
});
