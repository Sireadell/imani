// GET /api/check?round=<name>: the verdict for a round shipped with Imani, as plain JSON.
// It runs the same checker as the command line (scan level, from the saved blocks in
// examples/<round>/chain.json) and answers with the verdict, the number of checks passed, the
// block range read, where the blocks came from and how long it took. It takes a round name from
// a fixed list and nothing else, so it cannot receive a key or a file.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLot } from "../check.ts";
import { scanFromChain } from "../scan/input.ts";

/** The rounds this address will check. Add a name here only when its files are in examples/. */
export const ROUNDS: readonly string[] = ["testnet-01", "mainnet-01"];

export interface CheckAnswer {
  round: string;
  verdict: "PASS" | "FAIL";
  checks: { passed: number; total: number };
  failed: string[];
  network: string;
  lotId: string;
  blockRange: { from: number; to: number; blocks: number } | null;
  source: { kind: string; label: string; serversContacted: string[] };
  tookMs: number;
}

function examplesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From src/relay the examples are two levels up; from the bundled api/check.mjs one level up.
  for (const up of ["..", "../.."]) {
    const d = join(here, up, "examples");
    if (existsSync(d)) return d;
  }
  throw new Error("examples folder not found");
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Check one shipped round. `dir` is only for tests. */
export function checkRound(round: string, dir: string = examplesDir()): CheckAnswer {
  if (!ROUNDS.includes(round)) throw new RangeError("unknown round");
  const started = Date.now();
  const d = readJson(join(dir, round, "disclosure.json"));
  const r = readJson(join(dir, round, "result.json"));
  const chain = readJson(join(dir, round, "chain.json"));
  const scan = scanFromChain(d, chain, { label: `the saved blocks of examples/${round}` });
  const v = checkLot(d, r, { scan });
  const range = v.scanRange;
  return {
    round,
    verdict: v.result,
    checks: { passed: v.checks.filter((c) => c.status === "PASS").length, total: v.checks.length },
    failed: v.failed,
    network: v.network,
    lotId: v.lotId,
    blockRange: range ? { from: range.from, to: range.to, blocks: range.to - range.from + 1 } : null,
    source: { kind: scan.source.kind, label: scan.source.label, serversContacted: scan.source.serversContacted },
    tookMs: Date.now() - started,
  };
}

const HEADERS = { "cache-control": "public, max-age=60", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "access-control-allow-origin": "*" };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The "Verified fair" badge: a small SVG a seller can show on a lot page. It holds the verdict and the check counts, nothing else. */
export function badgeSvg(a: CheckAnswer): string {
  const pass = a.verdict === "PASS";
  const right = pass ? `PASS ${a.checks.passed}/${a.checks.total}` : `FAIL ${a.failed.length} of ${a.checks.total}`;
  const label = "Imani verified fair";
  const lw = 132;
  const rw = Math.max(72, 14 + right.length * 7);
  const alt = pass ? `Imani: ${a.round} checked fair, ${a.checks.passed} of ${a.checks.total} checks passed` : `Imani: ${a.round} failed ${a.failed.length} checks`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="24" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title><rect width="${lw}" height="24" fill="#1b2330"/><rect x="${lw}" width="${rw}" height="24" fill="${pass ? "#1a6b3a" : "#a32020"}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="12" text-anchor="middle"><text x="${lw / 2}" y="16">${label}</text><text x="${lw + rw / 2}" y="16" font-weight="bold">${esc(right)}</text></g></svg>`;
}

/** Request handler for /api/check. The shipped files never change while the server runs, so a round is checked once and the answer is kept. */
export function checkApi(dir?: string) {
  const kept = new Map<string, CheckAnswer>();
  return (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "Only GET" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const keys = [...url.searchParams.keys()];
    const round = url.searchParams.get("round");
    const format = url.searchParams.get("format");
    if (!round || keys.some((k) => k !== "round" && k !== "format") || (format !== null && format !== "svg")) return send(400, { error: "Give ?round=<name> (and optionally &format=svg)", rounds: ROUNDS });
    if (!ROUNDS.includes(round)) return send(404, { error: "unknown round", rounds: ROUNDS });
    try {
      if (!kept.has(round)) kept.set(round, checkRound(round, dir));
      if (format === "svg") {
        res.writeHead(200, { ...HEADERS, "content-type": "image/svg+xml; charset=utf-8" });
        return void res.end(badgeSvg(kept.get(round)!));
      }
      send(200, kept.get(round));
    } catch {
      send(500, { error: "could not check this round" });
    }
  };
}
