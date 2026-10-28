// The public list of checked rounds (site/rounds.html). Built from the repo's own example files:
// every row is produced by running the real checker at build time. Nothing is typed by hand,
// the page has no script, and it never prints a viewing key.
import { checkLot } from "../src/check.ts";
import { checkExternalRound } from "../src/external/published-round.ts";
import { blocksInRange } from "../src/scan/chain.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange } from "../src/scan/scan.ts";
import { exampleData, listOnlyData } from "./site-build.ts";
import { certificateFile } from "./certificate.ts";

export type RoundKind = "real" | "honest" | "tampered" | "published";

export interface RoundRow {
  id: string;
  kind: RoundKind;
  title: string;
  network: string;
  blocks: string;
  result: "PASS" | "FAIL";
  passed: number;
  total: number;
  /** Checks that failed, by id. Empty for a PASS. */
  failing: string[];
  /** True when the result is the one the example was built to give. */
  expected: boolean;
  checked: string;
  link: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The day the list was built and re-checked (UTC). Override with IMANI_CHECKED_DATE for a repeatable build. */
export function checkedDate(): string {
  return process.env.IMANI_CHECKED_DATE || new Date().toISOString().slice(0, 10);
}

export function roundRows(date = checkedDate()): RoundRow[] {
  const data = exampleData();
  const extra = listOnlyData();
  const { externals } = data;
  const blobs = { ...data.blobs, ...extra.blobs };
  const rows: RoundRow[] = [];
  for (const e of [...data.entries, ...extra.entries]) {
    const d = JSON.parse(blobs[e.disclosure]);
    const r = JSON.parse(blobs[e.result]);
    let scan;
    let blocks = d.openHeight !== undefined ? `${fmt(d.openHeight)} to ${fmt(d.closeHeight)}` : `closes at ${fmt(d.closeHeight)}`;
    if (e.chain) {
      const range = scanRange(d, DEFAULT_GRACE_BLOCKS);
      const chain = JSON.parse(blobs[e.chain]);
      const { blocks: bl, missing } = blocksInRange(chain, range.from, range.to);
      scan = { blocks: bl, missing, source: { kind: "chain-file" as const, label: "chain.json (offline)", serversContacted: [], bytes: 0, ms: 0 }, graceBlocks: range.graceBlocks };
      blocks = `${fmt(range.from)} to ${fmt(range.to)}`;
    }
    const v = checkLot(d, r, { scan });
    const failing = v.checks.filter((c) => c.status === "FAIL").map((c) => c.id);
    const wantFail: string[] = e.expectedFailingChecks ?? (e.expectedFailingCheck ? [e.expectedFailingCheck] : []);
    const expected = wantFail.length === 0 ? v.result === "PASS" : v.result === "FAIL" && wantFail.every((id) => failing.includes(id));
    rows.push({
      id: e.id,
      kind: e.group === "real-honest" ? "real" : e.group.endsWith("honest") ? "honest" : "tampered",
      title: e.title,
      network: v.network,
      blocks,
      result: v.result === "PASS" ? "PASS" : "FAIL",
      passed: v.checks.filter((c) => c.status === "PASS").length,
      total: v.checks.length,
      failing,
      expected,
      checked: date,
      link: e.link ?? `index.html#round=${encodeURIComponent(e.id)}`,
    });
  }
  for (const x of externals) {
    const file = JSON.parse(blobs[x.blob]);
    const rep = checkExternalRound(file);
    const h = file.deadline_height ?? file.close_height;
    rows.push({
      id: x.id,
      kind: "published",
      title: x.title,
      network: "not stated in the file",
      blocks: Number.isSafeInteger(h) ? `deadline block ${fmt(h)}` : "not stated in the file",
      result: rep.result,
      passed: rep.lines.filter((l) => l.status === "PASS").length,
      total: rep.lines.length,
      failing: rep.lines.filter((l) => l.status === "FAIL").map((l) => l.id),
      expected: x.id === "external-tampered" ? rep.result === "FAIL" : rep.result === "PASS",
      checked: date,
      link: `index.html#external=${encodeURIComponent(x.id)}`,
    });
  }
  return rows;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const SECTIONS: [RoundKind, string, string][] = [
  ["real", "Real round", "Paid and refunded for real: one round on the public Zcash test network, one on Zcash mainnet."],
  ["published", "Rounds published by other projects", "Read from the files those projects published. The last one has one refund changed on purpose. The settlement file's 3 payments are on Zcash mainnet: two independent servers returned the same bytes for each, mined in blocks 3,499,413 and 3,499,451. Their amounts stay unread, because no key for that round was published."],
  ["honest", "Example rounds", "Made for testing. Every file is right, so each should PASS."],
  ["tampered", "Examples with one deliberate change", "Examples, not real auctions. Each has one thing changed on purpose, so each should FAIL."],
];

export function roundsPage(rows: RoundRow[]): string {
  const body = SECTIONS.map(([kind, h, note]) => {
    const rs = rows.filter((r) => r.kind === kind);
    if (!rs.length) return "";
    const trs = rs
      .map(
        (r) =>
          `<tr><td>${esc(r.title)}<br><span class="muted small">${esc(r.id)}</span></td><td>${esc(r.network)}</td><td>${esc(r.blocks)}</td><td class="${r.result === "PASS" ? "pass" : "fail"}">${r.result}${r.result === "FAIL" ? ` (${esc(r.failing.join(", "))})` : ""}</td><td>${r.passed} of ${r.total}</td><td>${esc(r.checked)}</td><td><a href="${r.link}">Re-check it yourself</a> <a href="${certificateFile(r.id)}">Certificate</a></td></tr>`,
      )
      .join("\n");
    return `<section><h2>${h}</h2><p class="muted">${note}</p><div class="tablewrap"><table><thead><tr><th>Round</th><th>Network</th><th>Blocks</th><th>Result</th><th>Checks passed</th><th>Checked</th><th></th></tr></thead><tbody>\n${trs}\n</tbody></table></div></section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Imani checked rounds</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top">
  <div class="wrap">
    <nav class="nav" aria-label="Pages"><a href="index.html">Auction check</a> <a href="check.html">Check any round</a></nav>
    <h1>Checked rounds</h1>
    <p class="lead">Every round Imani ships or has checked. This list was made when the site was built, by running the checker on each round's own files. No result is typed in by hand. "Re-check it yourself" opens the checker on that round, so your browser works it out again.</p>
    <p class="servers"><strong>Servers contacted: none.</strong> This page has no script and makes no network calls after it loads.</p>
  </div>
</header>
<main class="wrap">
${body}
</main>
</body>
</html>
`;
}
