// npm run leak-scan: fail if any tracked file holds something shaped like a viewing key, a
// spending key, a seed phrase, or is a .env file. Public test keys are listed, with a reason,
// in tools/leak-scan.allow.json. Reads only; changes nothing.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

/** The files to scan: what git tracks, or, in a copy with no git history (a ZIP download), every file outside node_modules, dist and .git. */
function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!["node_modules", "dist", ".git"].includes(e.name)) walk(rel);
        } else if (e.isFile()) out.push(rel);
      }
    };
    walk("");
    return out;
  }
}

/** Scan every file git tracks in `root` (or every file, with no git history). Skips binary files. */
export function scanRepo(root: string, list: AllowEntry[]): Finding[] {
  const names = listFiles(root);
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

/**
 * Scan every file in every commit of `root`, so a key that was committed and later deleted is
 * still found. Each distinct file version is read once and named by the oldest commit holding it.
 */
export function scanHistory(root: string, list: AllowEntry[]): Finding[] {
  const run = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, input });
  const commits = run(["rev-list", "--all", "--reverse"]).split("\n").filter(Boolean);
  const versions = new Map<string, { file: string; blob: string; commit: string }>();
  for (const c of commits) {
    for (const entry of run(["ls-tree", "-r", "-z", c]).split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [, type, blob] = entry.slice(0, tab).split(" ");
      const file = entry.slice(tab + 1);
      const k = `${file}\0${blob}`;
      if (type === "blob" && !versions.has(k)) versions.set(k, { file, blob, commit: c.slice(0, 7) });
    }
  }
  const out: Finding[] = [];
  for (const v of versions.values()) {
    const buf = execFileSync("git", ["cat-file", "blob", v.blob], { cwd: root, maxBuffer: 1 << 30 });
    const text = buf.includes(0) ? "" : buf.toString("utf8");
    for (const f of scanFile(v.file, text, list)) out.push({ file: f.file, problem: `${f.problem} (commit ${v.commit})` });
  }
  return out;
}

if (process.argv[1]?.endsWith("leak-scan.ts")) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const list = loadAllowlist(fileURLToPath(new URL("./leak-scan.allow.json", import.meta.url)));
  const history = process.argv.includes("--history");
  const findings = history ? scanHistory(root, list) : scanRepo(root, list);
  if (findings.length) {
    console.error("leak-scan FAILED:");
    for (const f of findings) console.error(`  ${f.file}: ${f.problem}`);
    console.error(`${findings.length} problem(s). The key itself is not printed. Remove it, or if it is a public test key, add the file to tools/leak-scan.allow.json with a reason.`);
    process.exitCode = 1;
  } else {
    console.log(`leak-scan: clean. No viewing key, spending key, seed phrase or .env in any ${history ? "file of any commit in the history" : "tracked file"} (${list.length} allowlisted public test-key paths).`);
  }
}
