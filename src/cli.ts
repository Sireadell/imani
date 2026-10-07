import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLot, InputError, KeyRefusedError } from "./check.ts";
import { toHtml, toText } from "./report.ts";

const USAGE = `Usage: imani check --disclosure <lot disclosure.json> --result <seller result.json> [--basic] [--discreet] [--out <folder>]

  --basic     run only the checks that need no key
  --discreet  hide amounts and memos in everything printed or written
  --out       also write verdict.json and report.html into this folder

Exit code: 0 PASS, 1 FAIL, 2 refused or bad input.`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`Input error: cannot read the ${what} file at ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`Input error: the ${what} file is not valid JSON.`);
  }
}

/** Runs the command and returns what it would print. Never prints the lot key, never writes it. */
export function run(argv: string[]): CliResult {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") return { code: 2, stdout: "", stderr: USAGE };
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--basic" || a === "--discreet") opts[a.slice(2)] = true;
    else if ((a === "--disclosure" || a === "--result" || a === "--out") && rest[i + 1] && !rest[i + 1].startsWith("--")) {
      opts[a.slice(2)] = rest[++i];
    } else return { code: 2, stdout: "", stderr: `Unknown or incomplete option: ${a}\n\n${USAGE}` };
  }
  if (typeof opts.disclosure !== "string" || typeof opts.result !== "string") {
    return { code: 2, stdout: "", stderr: USAGE };
  }
  try {
    const d = readJson(opts.disclosure, "disclosure") as any;
    const r = readJson(opts.result, "result") as any;
    const v = checkLot(d, r, { basicOnly: !!opts.basic, discreet: !!opts.discreet });
    let stdout = toText(v);
    if (typeof opts.out === "string") {
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(join(opts.out, "verdict.json"), JSON.stringify(v, null, 2) + "\n");
      writeFileSync(join(opts.out, "report.html"), toHtml(v));
      stdout += `\nWrote ${join(opts.out, "verdict.json")} and ${join(opts.out, "report.html")}`;
    }
    return { code: v.result === "PASS" ? 0 : 1, stdout, stderr: "" };
  } catch (e) {
    if (e instanceof KeyRefusedError || e instanceof InputError) {
      return { code: 2, stdout: "", stderr: `${e.message}\nServers contacted: none` };
    }
    // Unknown errors: show a fixed message so nothing from the input can leak into the output.
    return { code: 2, stdout: "", stderr: "Unexpected error while checking. Nothing was written.\nServers contacted: none" };
  }
}

export function main(argv: string[]): void {
  const res = run(argv);
  if (res.stdout) process.stdout.write(res.stdout + "\n");
  if (res.stderr) process.stderr.write(res.stderr + "\n");
  process.exitCode = res.code;
}
