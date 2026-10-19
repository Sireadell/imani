import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { assertNoSecret, findSecret, LeakGuardError, maskDiscreet } from "../src/guard.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ex = (p: string) => join(root, "examples", p);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// Built at run time so no key-shaped text sits in this file.
const CANARY_VIEW = "uviewtest1" + "canarysecret".repeat(5);
const CANARY_SPEND = "secret-extended-key-test1" + "canarysecret".repeat(5);
const CANARY_SEED = ["legal", "winner", "thank", "year", "wave", "sausage", "worth", "useful", "legal", "winner", "thank", "yellow"].join(" ");

const tmp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "imani-leak-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Everything a run produced: stdout, stderr and every file it wrote. */
const everything = (res: { stdout: string; stderr: string }, outDir?: string) => {
  let all = res.stdout + "\n" + res.stderr;
  if (outDir && existsSync(outDir)) for (const f of readdirSync(outDir)) all += "\n" + readFileSync(join(outDir, f), "utf8");
  return all;
};

/** True when the text holds the key whole or any 24-character stretch of it. */
const hasKey = (text: string, key: string) => {
  for (let i = 0; i + 24 <= key.length; i += 6) if (text.includes(key.slice(i, i + 24))) return true;
  return text.includes(key.slice(-24));
};

test("guard names what it blocks and never repeats it", () => {
  assert.equal(findSecret(`key ${CANARY_VIEW} end`), "viewing key");
  assert.equal(findSecret(CANARY_SPEND), "spending key");
  assert.equal(findSecret(`"${CANARY_SEED}"`), "seed phrase");
  assert.equal(findSecret("seed: " + "abandon ".repeat(23) + "art"), "seed phrase");
  assert.equal(findSecret("refund:LOT-01:d928588fc1669a65 for bid 2"), null);
  assert.equal(findSecret("Every listed bid amount equals the amount the key reads from the chain."), null);
  for (const s of [CANARY_VIEW, CANARY_SPEND, CANARY_SEED]) {
    assert.throws(
      () => assertNoSecret(`memo text ${s}`, "a memo"),
      (e: Error) => e instanceof LeakGuardError && /^Blocked: a memo would contain something shaped like a/.test(e.message) && !e.message.includes(s.slice(0, 30)),
    );
  }
  assert.doesNotThrow(() => assertNoSecret("refund:LOT-01:d928588fc1", "a memo"));
});

test("the guard also catches revision 2 unified viewing keys (uvf, uvi) on both networks", () => {
  const body = "canarysecret".repeat(5);
  for (const hrp of ["uvf", "uvftest", "uvi", "uvitest"]) {
    assert.equal(findSecret(`key ${hrp}1${body} end`), "viewing key", hrp);
    assert.throws(() => assertNoSecret(`${hrp}1${body}`, "the memo"), LeakGuardError, hrp);
  }
  // Harmless look-alikes: too short to be a key, or the prefix is just part of a word.
  for (const hrp of ["uvf", "uvftest", "uvi", "uvitest"]) assert.equal(findSecret(`${hrp}1abc`), null, `${hrp} short`);
  assert.equal(findSecret("the uvi index and uvf1 are not keys"), null);
});

test("a key-shaped lot name is stopped before anything is printed or written", () => {
  tmp((dir) => {
    for (const secret of [CANARY_VIEW, CANARY_SPEND, CANARY_SEED]) {
      const d = read(ex("round-01/disclosure.json"));
      const r = read(ex("round-01/result.json"));
      delete d.ufvk;
      d.lotId = r.lotId = `LOT ${secret}`; // the lot name is printed and written, so it must be blocked
      writeFileSync(join(dir, "d.json"), JSON.stringify(d));
      writeFileSync(join(dir, "r.json"), JSON.stringify(r));
      const out = join(dir, "out");
      const res = run(["check", "--disclosure", join(dir, "d.json"), "--result", join(dir, "r.json"), "--basic", "--out", out]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /^(Input error|Blocked)/);
      assert.match(res.stderr, /Servers contacted: none/);
      assert.ok(!existsSync(out), "no output folder or file was created");
      assert.ok(!hasKey(everything(res), secret));
    }
  });
});

test("a viewing key that shows payments outside the lot is named, with the fix", () => {
  const res = run(["check", "--disclosure", ex("guards/outside-payment/disclosure.json"), "--result", ex("guards/outside-payment/result.json")]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /FAIL {2}Lot key shows only this lot's payments\. The key shows 1 payment\(s\) into this address that are not bids/);
  assert.match(res.stdout, /Use a fresh one-time key for every lot/);
  assert.match(res.stdout, /RESULT: FAIL \(1 of 15 checks failed: key-hygiene\)/);
});

test("spending keys and seed phrases in the lot key slot are refused with exit 2 and never echoed", () => {
  tmp((dir) => {
    for (const secret of [CANARY_SPEND, CANARY_SEED, CANARY_VIEW]) {
      const d = read(ex("round-01/disclosure.json"));
      d.ufvk = secret;
      writeFileSync(join(dir, "d.json"), JSON.stringify(d));
      const res = run(["check", "--disclosure", join(dir, "d.json"), "--result", ex("round-01/result.json"), "--out", join(dir, "o")]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /Refused/);
      assert.ok(!hasKey(everything(res), secret), "the refused key is not repeated");
      assert.ok(!existsSync(join(dir, "o")));
    }
  });
});

test("offline mode: --offline works with files and refuses --fetch; every run names the servers contacted", () => {
  const base = ["check", "--disclosure", ex("round-01/disclosure.json"), "--result", ex("round-01/result.json")];
  const ok = run([...base, "--offline"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Servers contacted: none/);
  const both = run([...base, "--offline", "--scan", "--fetch"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--offline and --fetch cannot be combined/);
  assert.match(both.stderr, /Servers contacted: none/);
  const scan = run(["check", "--disclosure", ex("scan-01/disclosure.json"), "--result", ex("scan-01/result.json"), "--scan", "--chain", ex("scan-01/chain.json"), "--offline"]);
  assert.equal(scan.code, 0);
  assert.match(scan.stdout, /Servers contacted: none/);
});

// ---------- --discreet ----------

const amountsIn = (v: unknown, out: Set<number> = new Set()): Set<number> => {
  if (Array.isArray(v)) v.forEach((x) => amountsIn(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/zat$/i.test(k) && typeof x === "number" && x >= 1000) out.add(x);
      else amountsIn(x, out);
    }
  }
  return out;
};

const DIRS = [
  "round-01",
  "broken/01-extra-fake-bid",
  "broken/02-wrong-bid-amount",
  "broken/03-missing-refund",
  "broken/04-short-refund",
  "broken/05-wrong-clearing-price",
  "broken/06-late-bid-counted",
  "guards/outside-payment",
  "guards/other-lot-bid",
  "guards/replayed-bid",
];

test("--discreet: no raw amount or address in the text, verdict.json or report.html", () => {
  tmp((dir) => {
    for (const name of [...DIRS, "scan-01", "scan-broken/01-hidden-bid"]) {
      const scan = name.startsWith("scan");
      const out = join(dir, name.replace("/", "_"));
      const args = ["check", "--disclosure", ex(`${name}/disclosure.json`), "--result", ex(`${name}/result.json`), "--discreet", "--out", out];
      if (scan) args.push("--scan", "--chain", ex(`${name}/chain.json`));
      if (name === "scan-01") args.push("--bidder-keys", ex("scan-01/bidder-keys.json"));
      const res = run(args);
      assert.ok(res.code === 0 || res.code === 1, `${name} ran`);
      const amounts = [...amountsIn(read(ex(`${name}/result.json`)))];
      assert.ok(amounts.length > 0);
      const text = everything(res, out);
      for (const a of amounts) {
        assert.ok(!text.includes(a.toLocaleString("en-US")), `${name}: ${a} shown with commas`);
        assert.ok(!new RegExp(`(?<![0-9])${a}(?![0-9])`).test(text), `${name}: ${a} shown raw`);
      }
      assert.ok(!/(?:utest|u|zs|ztestsapling)1[02-9ac-hj-np-z]{30,}/.test(text), `${name}: an address-shaped string is visible`);
      assert.ok(!/(?:uview|uviewtest)1/.test(text), `${name}: a key prefix is visible`);
      assert.ok(text.includes("[hidden]"));
    }
  });
});

test("--discreet masks addresses and amounts in any text", () => {
  const addr = "utest1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(3);
  const t = maskDiscreet(`paid ${addr} the sum of 1,500,000 zat, then 250 zat and 0.0125 ZEC to t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs`);
  assert.ok(!t.includes(addr.slice(0, 20)));
  assert.ok(!/\d/.test(t.replace(/\[hidden]|\[address hidden]/g, "")));
  assert.equal((t.match(/\[address hidden]/g) ?? []).length, 2);
});

// ---------- no key in any output, URL, file or log ----------

test("leak scan: the lot key never shows up in stdout, stderr or any file the checker writes", () => {
  tmp((dir) => {
    const cases: { name: string; dirName: string; extra: string[] }[] = [
      { name: "plain", dirName: "round-01", extra: [] },
      { name: "basic", dirName: "round-01", extra: ["--basic"] },
      { name: "discreet", dirName: "round-01", extra: ["--discreet"] },
      { name: "failing", dirName: "broken/04-short-refund", extra: [] },
      { name: "outside", dirName: "guards/outside-payment", extra: [] },
      { name: "scan", dirName: "scan-01", extra: ["--scan", "--chain", ex("scan-01/chain.json"), "--bidder-keys", ex("scan-01/bidder-keys.json")] },
      { name: "scan-fail", dirName: "scan-broken/01-hidden-bid", extra: ["--scan", "--chain", ex("scan-broken/01-hidden-bid/chain.json")] },
    ];
    for (const c of cases) {
      const d = read(ex(`${c.dirName}/disclosure.json`));
      const keys = [d.ufvk as string];
      if (c.name === "scan") keys.push(...read(ex("scan-01/bidder-keys.json")).keys.map((k: any) => k.ufvk));
      const out = join(dir, c.name);
      const res = run(["check", "--disclosure", ex(`${c.dirName}/disclosure.json`), "--result", ex(`${c.dirName}/result.json`), ...c.extra, "--out", out]);
      const text = everything(res, out);
      assert.equal(readdirSync(out).length, 2, `${c.name}: wrote verdict.json and report.html`);
      for (const k of keys) assert.ok(!hasKey(text, k), `${c.name}: a key is in the output`);
      assert.equal(findSecret(text), null, `${c.name}: output has nothing key-shaped`);
      assert.ok(!/https?:\/\/[^\s"]*(uview|ufvk)/i.test(text), `${c.name}: no key in a URL`);
    }
  });
});

test("leak scan: the real CLI process and the demo script print and write no key", () => {
  tmp((dir) => {
    const key = read(ex("round-01/disclosure.json")).ufvk as string;
    const out = join(dir, "o");
    const cli = spawnSync(process.execPath, [join(root, "bin/imani.js"), "check", "--disclosure", ex("round-01/disclosure.json"), "--result", ex("round-01/result.json"), "--out", out], { encoding: "utf8", cwd: dir });
    assert.equal(cli.status, 0);
    assert.ok(!hasKey(everything({ stdout: cli.stdout, stderr: cli.stderr }, out), key));
    const demo = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "tools/demo.ts")], { encoding: "utf8", cwd: root });
    assert.equal(demo.status, 0, demo.stderr);
    for (const k of [key, read(ex("scan-broken/01-hidden-bid/disclosure.json")).ufvk]) assert.ok(!hasKey(demo.stdout + demo.stderr, k));
    assert.equal(findSecret(demo.stdout + demo.stderr), null);
  });
});
