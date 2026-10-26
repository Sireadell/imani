// Scores any checker against conformance/manifest.json.
//   npm run conformance -- --cmd "node bin/imani.js check"
//
// The checker command gets `--disclosure <file> --result <file>` added (and `--scan --chain <file>`
// for the cases that scan). It must exit 0 for PASS and 1 for FAIL, and print the id of every
// check it fails. Exit 0 with output "RESULT: FAIL" is not accepted: the exit code is the verdict.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface CaseResult {
  id: string;
  kind: "honest" | "broken";
  verdictRight: boolean;
  namedRight: boolean;
  note: string;
}
export interface Score {
  total: number;
  verdictRight: number;
  broken: number;
  named: number;
  honest: number;
  honestPassed: number;
  results: CaseResult[];
}

export function runConformance(cmd: string, manifestPath = "conformance/manifest.json"): Score {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const results: CaseResult[] = [];
  for (const c of m.cases) {
    const extra = ["--disclosure", c.disclosure, "--result", c.result, ...(c.chain ? ["--scan", "--chain", c.chain] : [])];
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const r = spawnSync(`${cmd} ${extra.map(q).join(" ")}`, { shell: true, encoding: "utf8", maxBuffer: 1 << 26 });
    const said = r.status === 0 ? "PASS" : r.status === 1 ? "FAIL" : "ERROR";
    const text = `${r.stdout}\n${r.stderr}`;
    const verdictRight = said === c.expect;
    // Whole-word match, so "refunds-paid" is not found inside "refunds-paid-late".
    const namedRight = c.kind === "broken" ? verdictRight && c.failing.every((id: string) => new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`).test(text)) : verdictRight;
    results.push({ id: c.id, kind: c.kind, verdictRight, namedRight, note: verdictRight ? (namedRight ? "ok" : `FAIL but did not name ${c.failing.join(", ")}`) : `expected ${c.expect}, got ${said}` });
  }
  const broken = results.filter((r) => r.kind === "broken");
  const honest = results.filter((r) => r.kind === "honest");
  return {
    total: results.length,
    verdictRight: results.filter((r) => r.verdictRight).length,
    broken: broken.length,
    named: broken.filter((r) => r.namedRight).length,
    honest: honest.length,
    honestPassed: honest.filter((r) => r.verdictRight).length,
    results,
  };
}

export function scoreText(s: Score): string {
  const lines = s.results.filter((r) => !r.verdictRight || !r.namedRight).map((r) => `  ${r.id}: ${r.note}`);
  return [
    ...lines,
    `Right verdict: ${s.verdictRight} of ${s.total} (honest rounds passed: ${s.honestPassed} of ${s.honest}; broken copies failed: ${s.results.filter((r) => r.kind === "broken" && r.verdictRight).length} of ${s.broken})`,
    `Broken copies failed on the right check: ${s.named} of ${s.broken}`,
    `Conformance: ${s.verdictRight === s.total && s.named === s.broken ? "FULL" : "PARTIAL"} (${s.verdictRight} of ${s.total} verdicts right, ${s.named} of ${s.broken} broken copies named correctly)`,
  ].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("conformance.ts")) {
  const i = process.argv.indexOf("--cmd");
  if (i < 0 || !process.argv[i + 1]) {
    console.error('Usage: npm run conformance -- --cmd "<checker command>"');
    process.exit(2);
  }
  const s = runConformance(process.argv[i + 1]);
  console.log(scoreText(s));
  process.exit(s.verdictRight === s.total && s.named === s.broken ? 0 : 1);
}
