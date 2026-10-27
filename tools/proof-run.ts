// Runs each command in docs/PROOF.md and compares the line it prints with the line in the file.
// Run: node tools/proof-run.ts          (quick rows only; slow rows are listed as skipped)
//      node tools/proof-run.ts --all    (every row, including the whole test run and the browser build)
// Exit code 0 when every row that ran printed the same line, 1 otherwise.
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Row { claim: string; command: string; expected: string }
export interface Outcome { command: string; expected: string; status: "same" | "different" | "skipped"; printed: string }

const root = fileURLToPath(new URL("../", import.meta.url));
const SLOW = [/^npm run test:all\b/, /leak-scan:history/, /^npm run conformance/, /browser-bundle\.test\.ts/];
export const isSlow = (command: string) => SLOW.some((re) => re.test(command));

/** Reads the table rows: | claim | `command` | `result line` |. */
export function parseProof(md: string): Row[] {
  const rows: Row[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/);
    if (m) rows.push({ claim: m[1], command: m[2], expected: m[3] });
  }
  return rows;
}

function run(command: string): Promise<string> {
  return new Promise((done) => {
    exec(command, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => done(`${stdout}\n${stderr}`));
  });
}

export async function runProof(rows: Row[], opts: { all: boolean }): Promise<Outcome[]> {
  const cache = new Map<string, string[]>();
  const out: Outcome[] = [];
  for (const r of rows) {
    if (isSlow(r.command) && !opts.all) { out.push({ command: r.command, expected: r.expected, status: "skipped", printed: "" }); continue; }
    if (!cache.has(r.command)) cache.set(r.command, (await run(r.command)).split(/\r?\n/).map((l) => l.trim()));
    const lines = cache.get(r.command)!;
    const hit = lines.includes(r.expected);
    out.push({ command: r.command, expected: r.expected, status: hit ? "same" : "different", printed: hit ? r.expected : lines.filter(Boolean).slice(-3).join(" / ") });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = parseProof(readFileSync(new URL("../docs/PROOF.md", import.meta.url), "utf8"));
  const results = await runProof(rows, { all: process.argv.includes("--all") });
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(9)} ${r.command}${r.status === "different" ? `\n          expected: ${r.expected}\n          printed:  ${r.printed}` : ""}`);
  const bad = results.filter((r) => r.status === "different").length;
  console.log(bad ? `\nproof-run: ${bad} of ${results.length} rows differ.` : `\nproof-run: ${results.filter((r) => r.status === "same").length} rows match, ${results.filter((r) => r.status === "skipped").length} skipped.`);
  process.exit(bad ? 1 : 0);
}
