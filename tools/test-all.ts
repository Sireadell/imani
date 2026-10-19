// Runs every test group, then checks that the test counts written in the docs match the run.
// Run: npm run test:all            (fails if a group fails or a count in the docs is out of date)
//      npm run test:all -- --write (same run, then rewrites the counts in the docs)
// A count in a doc is written as <!--count:KEY-->N<!--/count-->, so a reader sees only N.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const groups = [
  { script: "test", what: "The checker: reading payments with a viewing key, the auction rules, each check level, the bidder's own check, refusing spending keys, the packed package, the leak scanner" },
  { script: "test:login", what: "Sign-in with a private wallet: one-time codes, expiry, replays, copied links, wrong sites, the receipt, a real test-network payment" },
  { script: "test:fetch", what: "Downloading blocks from two public servers and checking they agree" },
  { script: "test:demo", what: "The auction shop demo, from sign-in to the checked result" },
  { script: "test:scan", what: "The scan that reads every block of an auction to find bids the seller left out" },
  { script: "test:site", what: "The browser page and the page that checks any round: same answers as the command line, no network calls" },
  { script: "test:tamper", what: "Change one fact at a time in every example round; none of the changed copies may pass" },
  { script: "test:external", what: "Rounds another auction project published, read from their own files" },
  { script: "test:privacy", what: "Refund linking, the who-learns-what table, keys never printed or saved" },
] as const;

const docs = ["docs/JUDGE_GUIDE.md", "docs/HOW_WE_TESTED.md"];
const root = new URL("../", import.meta.url);
const write = process.argv.includes("--write");

type Count = { tests: number; pass: number; fail: number; skipped: number };

function run(script: string): Promise<{ code: number; count: Count }> {
  return new Promise((done) => {
    const child = spawn(`npm run ${script}`, { shell: true, cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.on("close", (code) => {
      const last = (k: string) => Number([...out.matchAll(new RegExp(`^# ${k} (\\d+)`, "gm"))].at(-1)?.[1] ?? NaN);
      done({ code: code ?? 1, count: { tests: last("tests"), pass: last("pass"), fail: last("fail"), skipped: last("skipped") } });
    });
  });
}

export function countValues(counts: Record<string, Count>): Record<string, number> {
  const all = Object.values(counts);
  const sum = (k: keyof Count) => all.reduce((n, c) => n + c[k], 0);
  const v: Record<string, number> = { total: sum("tests"), pass: sum("pass"), skipped: sum("skipped"), groups: all.length };
  for (const [script, c] of Object.entries(counts)) v[script] = c.tests;
  return v;
}

export function groupTable(counts: Record<string, Count>): string {
  const rows = groups.map((g) => {
    const c = counts[g.script];
    return `| \`npm run ${g.script}\` | ${g.what} | ${c.tests} | ${c.skipped ? `${c.skipped} (live, needs \`LIVE=1\`)` : "0"} |`;
  });
  return ["| Command | What it covers | Tests | Skipped |", "|---|---|---|---|", ...rows].join("\n");
}

// Replaces each <!--count:KEY-->N<!--/count--> and the table between the group markers.
export function fill(text: string, values: Record<string, number>, table: string): string {
  let out = text.replace(/<!--count:([\w:]+)-->\d*<!--\/count-->/g, (m, k) => {
    if (!(k in values)) throw new Error(`unknown count key ${k}`);
    return `<!--count:${k}-->${values[k]}<!--/count-->`;
  });
  const start = "<!-- test-groups:start -->";
  const end = "<!-- test-groups:end -->";
  const a = out.indexOf(start);
  const b = out.indexOf(end);
  // Keep the file's own line endings, so a Windows checkout with CRLF does not read as drift.
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  if (a >= 0 && b > a) out = out.slice(0, a) + [start, ...table.split("\n"), end].join(nl) + out.slice(b + end.length);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const counts: Record<string, Count> = {};
  for (const g of groups) {
    const r = await run(g.script);
    if (r.code !== 0 || r.count.fail > 0) {
      console.error(`\ntest:all: npm run ${g.script} failed.`);
      process.exit(1);
    }
    if (Number.isNaN(r.count.tests)) {
      console.error(`\ntest:all: could not read the test count of npm run ${g.script}.`);
      process.exit(1);
    }
    counts[g.script] = r.count;
  }
  const values = countValues(counts);
  const table = groupTable(counts);
  const stale: string[] = [];
  for (const d of docs) {
    const path = new URL(d, root);
    const before = readFileSync(path, "utf8");
    const after = fill(before, values, table);
    if (after === before) continue;
    if (write) writeFileSync(path, after);
    else stale.push(d);
  }
  console.log(`\ntest:all: ${values.total} tests in ${values.groups} groups, ${values.pass} passed, ${values.skipped} skipped, 0 failed.`);
  if (stale.length) {
    console.error(`The test counts in ${stale.join(" and ")} no longer match this run. Run: npm run test:all -- --write`);
    process.exit(1);
  }
  if (write) console.log("Test counts in the docs are up to date.");
}
