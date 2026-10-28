// Shows that every check Imani runs has a broken copy that makes it fail.
//   node --disable-warning=ExperimentalWarning tools/check-coverage.ts          prints the table
//   node --disable-warning=ExperimentalWarning tools/check-coverage.ts --write  rewrites docs/CHECK_COVERAGE.md
// The checks come from running the real checker on every case in conformance/manifest.json, so
// nothing here is typed in by hand.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface CoverageRow {
  id: string;
  title: string;
  failsOn: string[];
}

interface Case {
  id: string;
  kind: "honest" | "broken";
  disclosure: string;
  result: string;
  chain?: string;
}

/** The 52 conformance cases, plus the broken copies in examples/checks-broken that cover the remaining checks. */
export function allCases(manifestPath = "conformance/manifest.json", extraPath = "examples/checks-broken/manifest.json"): Case[] {
  const cases: Case[] = JSON.parse(readFileSync(manifestPath, "utf8")).cases;
  const extra = JSON.parse(readFileSync(extraPath, "utf8"));
  for (const c of extra.copies) {
    const base = `examples/checks-broken/${c.name}`;
    cases.push({ id: `checks-broken/${c.name}`, kind: "broken", disclosure: `${base}/disclosure.json`, result: `${base}/result.json`, ...(c.chain ? { chain: `${base}/${c.chain}` } : {}) });
  }
  return cases;
}

export function coverage(): CoverageRow[] {
  const rows = new Map<string, CoverageRow>();
  const dir = mkdtempSync(join(tmpdir(), "imani-coverage-"));
  try {
    for (const c of allCases()) {
      const args = ["bin/imani.js", "check", "--disclosure", c.disclosure, "--result", c.result, ...(c.chain ? ["--scan", "--chain", c.chain] : []), "--out", dir];
      const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
      if (r.status !== 0 && r.status !== 1) throw new Error(`${c.id}: the checker exited with ${r.status}\n${r.stderr}`);
      const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
      for (const k of v.checks as { id: string; title: string; status: string }[]) {
        const row = rows.get(k.id) ?? { id: k.id, title: k.title, failsOn: [] };
        if (k.status === "FAIL" && c.kind === "broken") row.failsOn.push(c.id);
        rows.set(k.id, row);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function coverageMarkdown(rows: CoverageRow[]): string {
  const covered = rows.filter((r) => r.failsOn.length);
  const lines = [
    "# Every check can fail",
    "",
    "A checker that never says FAIL proves nothing. This table is made by running Imani on every round in `conformance/manifest.json` (10 honest, 42 broken copies) and on the 6 extra broken copies in `examples/checks-broken`, and recording which broken copies each check catches. Rebuild it with `node --disable-warning=ExperimentalWarning tools/check-coverage.ts --write`. A test fails if this file is out of date.",
    "",
    `**${covered.length} of ${rows.length} checks have at least one broken copy that makes them fail.**`,
    "",
    "| Check | What it proves | Broken copies that trip it | Example |",
    "|---|---|---|---|",
    ...rows.map((r) => `| \`${r.id}\` | ${r.title.replace(/\|/g, "/")} | ${r.failsOn.length || "none yet"} | ${r.failsOn.length ? `\`examples/${r.failsOn[0]}\`` : ""} |`),
    "",
  ];
  const missing = rows.filter((r) => !r.failsOn.length);
  if (missing.length) lines.push("Checks with no broken copy yet: " + missing.map((r) => `\`${r.id}\``).join(", ") + ".", "");
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("check-coverage.ts")) {
  const md = coverageMarkdown(coverage());
  if (process.argv.includes("--write")) writeFileSync("docs/CHECK_COVERAGE.md", md);
  else console.log(md);
}
