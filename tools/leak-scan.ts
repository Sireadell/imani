// npm run leak-scan: fail if any tracked file holds something shaped like a viewing key, a
// spending key, a seed phrase, or is a .env file. Public test keys are listed, with a reason,
// in tools/leak-scan.allow.json. Reads only; changes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { findSecret } from "../src/guard.ts";

export interface AllowEntry {
  /** A file path, or a folder ending in "/". */
  path: string;
  /** Why this file may hold a key. Required. */
  reason: string;
}
export interface Finding {
  file: string;
  problem: string;
}

const ENV_OK = /\.(example|sample|template)$/;

export function loadAllowlist(path: string): AllowEntry[] {
  const list = JSON.parse(readFileSync(path, "utf8")) as AllowEntry[];
  for (const e of list) {
    if (typeof e.path !== "string" || typeof e.reason !== "string" || e.reason.trim().length < 10) {
      throw new Error(`Allowlist entry needs a path and a real reason: ${JSON.stringify(e)}`);
    }
  }
  return list;
}

const allowed = (file: string, list: AllowEntry[]) => list.some((e) => (e.path.endsWith("/") ? file.startsWith(e.path) : file === e.path));

/** Scan one file's text. Allowlisted files are skipped for keys, never for .env. */
export function scanFile(file: string, text: string, list: AllowEntry[]): Finding[] {
  const out: Finding[] = [];
  const name = basename(file);
  if (/^\.env(\..*)?$/.test(name) && !ENV_OK.test(name)) out.push({ file, problem: "an .env file is tracked" });
  if (!allowed(file, list)) {
    // Line by line, so a seed phrase cannot hide across a line break and a hit names its line.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const kind = findSecret(lines[i]);
      if (kind) out.push({ file, problem: `line ${i + 1} holds something shaped like a ${kind}` });
    }
  }
  return out;
}

export function scanFiles(files: { file: string; text: string }[], list: AllowEntry[]): Finding[] {
  return files.flatMap((f) => scanFile(f.file, f.text, list));
}

/** Scan every file git tracks in `root`. Skips binary files. */
export function scanRepo(root: string, list: AllowEntry[]): Finding[] {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const files: { file: string; text: string }[] = [];
  const out: Finding[] = [];
  for (const file of names) {
    let buf: Buffer;
    try {
      buf = readFileSync(`${root}/${file}`);
    } catch {
      continue; // listed but deleted in the working copy
    }
    if (buf.includes(0)) {
      out.push(...scanFile(file, "", list)); // binary: only the .env rule applies
      continue;
    }
    files.push({ file, text: buf.toString("utf8") });
  }
  return [...out, ...scanFiles(files, list)];
}

if (process.argv[1]?.endsWith("leak-scan.ts")) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const list = loadAllowlist(fileURLToPath(new URL("./leak-scan.allow.json", import.meta.url)));
  const findings = scanRepo(root, list);
  if (findings.length) {
    console.error("leak-scan FAILED:");
    for (const f of findings) console.error(`  ${f.file}: ${f.problem}`);
    console.error(`${findings.length} problem(s). The key itself is not printed. Remove it, or if it is a public test key, add the file to tools/leak-scan.allow.json with a reason.`);
    process.exitCode = 1;
  } else {
    console.log(`leak-scan: clean. No viewing key, spending key, seed phrase or .env in any tracked file (${list.length} allowlisted public test-key paths).`);
  }
}
