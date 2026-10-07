import type { Check, Verdict } from "./check.ts";

const LEVEL_NAME = {
  1: "Basic level (no key needed)",
  2: "Key level (reads the lot's payments with the lot key)",
  3: "Scan level (reads every block in the lot's range with the lot key)",
} as const;

const levelStatus = (v: Verdict, level: 1 | 2 | 3) => (level === 1 ? v.basicLevel : level === 2 ? v.keyLevel : v.scanLevel);
const levelNote = (v: Verdict, level: 1 | 2 | 3) => (level === 2 ? v.keyLevelNote : level === 3 ? v.scanNotes.join(" ") : "");
const levels = (v: Verdict): (1 | 2 | 3)[] => (v.scanSource ? [1, 2, 3] : [1, 2]);

/** "none (offline...)" or the exact list of servers the scan opened a connection to. */
export function serversLine(v: Verdict): string {
  if (v.serversContacted.length) return v.serversContacted.join(", ");
  return v.scanSource ? "none (offline: reads only the files given, including the chain file)" : "none (offline: reads only the two files given)";
}

/** One plain sentence about the scan source, time and bytes. */
export function scanSourceLine(v: Verdict): string {
  if (!v.scanSource || !v.scanRange) return "";
  const r = v.scanRange;
  const s = v.scanSource;
  const kb = (s.bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `Scan range: blocks ${r.from} to ${r.to} (open ${r.openHeight}, close ${r.closeHeight}, refunds by ${r.refundByHeight}, grace window ${r.graceBlocks} blocks). Source: ${s.label}. ${(s.ms / 1000).toFixed(1)} s, ${kb} KB of transactions.`;
}

/** Plain text for the terminal. */
export function toText(v: Verdict): string {
  const lines: string[] = [];
  lines.push(`imani check: lot ${v.lotId} (${v.network} network)`);
  lines.push(`Servers contacted: ${serversLine(v)}`);
  lines.push(
    v.keyFingerprint
      ? `Lot key: accepted as read-only (fingerprint ${v.keyFingerprint}). Not printed, not saved.`
      : "Lot key: not used.",
  );
  if (v.discreet) lines.push("Discreet mode: amounts and memos are hidden.");
  for (const level of levels(v)) {
    const cs = v.checks.filter((c) => c.level === level);
    lines.push("");
    lines.push(`${LEVEL_NAME[level]}: ${levelStatus(v, level)}`);
    if (level === 3 && v.scanRange) lines.push(`  ${scanSourceLine(v)}`);
    if (!cs.length || level === 3) lines.push(`  ${levelNote(v, level)}`);
    for (const c of cs) lines.push(`  ${c.status}  ${level === 3 ? "[scan level] " : ""}${c.title}. ${c.reason}`);
  }
  lines.push("");
  lines.push("Where the numbers come from: amounts, memos and refunds are read from the transactions with the lot key.");
  lines.push("Bid list, winners, clearing price and refund list come from the seller's result file. Block heights and rules come from the disclosure file.");
  if (v.scanLevel !== "not run") lines.push("Scan level: every block in the range was read with the lot key, and the block heights were checked against the blocks the transactions were found in.");
  lines.push("");
  lines.push(
    v.result === "PASS"
      ? `RESULT: PASS (${v.checks.length} of ${v.checks.length} checks passed${v.keyLevel === "not run" ? ", basic level only" : ""})`
      : `RESULT: FAIL (${v.failed.length} of ${v.checks.length} checks failed: ${v.failed.join(", ")})`,
  );
  return lines.join("\n");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const list = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<span class="none">none</span>`;

function row(c: Check): string {
  return `<tr class="${c.status.toLowerCase()}">
<td><span class="badge">${c.status}</span>${c.level === 3 ? '<br><span class="tag">scan level</span>' : ""}</td>
<td><strong>${esc(c.title)}</strong><br><span class="reason">${esc(c.reason)}</span><br><code>${esc(c.id)}</code></td>
<td>${list(c.fromChain)}</td>
<td>${list(c.fromSeller)}</td>
<td>${list(c.fromDisclosure)}</td>
</tr>`;
}

/** One self-contained page: no scripts, no external files, no network requests. */
export function toHtml(v: Verdict): string {
  const section = (level: 1 | 2 | 3) => {
    const cs = v.checks.filter((c) => c.level === level);
    const status = levelStatus(v, level);
    const intro = level === 3 ? `<p>${esc(scanSourceLine(v))} ${esc(v.scanNotes.join(" "))}</p>` : "";
    const body = cs.length
      ? `<table><thead><tr><th>Result</th><th>Check</th><th>From the chain (read with the lot key)</th><th>From the seller's result file</th><th>From the disclosure file</th></tr></thead><tbody>${cs.map(row).join("")}</tbody></table>`
      : level === 3 ? "" : `<p>${esc(levelNote(v, level))}</p>`;
    return `<h2>${esc(LEVEL_NAME[level])}: <span class="${String(status).replace(" ", "-").toLowerCase()}">${esc(String(status))}</span></h2>${intro}${body}`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Lot ${esc(v.lotId)} check</title>
<style>
:root { --bg:#ffffff; --fg:#1b1f24; --muted:#5b6470; --line:#d8dde3; --pass:#17663a; --passbg:#e3f4ea; --fail:#a3221b; --failbg:#fbe5e3; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --fg:#e8eaed; --muted:#9aa3ad; --line:#2d333a; --pass:#6fd394; --passbg:#173322; --fail:#ff8a80; --failbg:#3a1a18; } }
body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; margin:0; padding:24px 16px; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:18px; margin:28px 0 8px; }
.verdict { font-size:22px; font-weight:700; padding:12px 16px; border-radius:8px; margin:16px 0; }
.verdict.pass { background:var(--passbg); color:var(--pass); } .verdict.fail { background:var(--failbg); color:var(--fail); }
.meta { color:var(--muted); margin:2px 0; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; vertical-align:top; padding:8px; border-bottom:1px solid var(--line); }
th { font-size:13px; color:var(--muted); font-weight:600; }
.badge { font-weight:700; } tr.pass .badge, span.pass { color:var(--pass); } tr.fail .badge, span.fail { color:var(--fail); }
tr.fail { background:var(--failbg); }
ul { margin:0; padding-left:18px; } code { color:var(--muted); font-size:12px; } .none { color:var(--muted); }
.reason { color:var(--fg); }
.tag { font-size:12px; color:var(--muted); white-space:nowrap; }
.wrap { overflow-x:auto; }
@media (max-width:700px) { th:nth-child(n+3), td:nth-child(n+3) { display:none; } }
</style>
</head>
<body><main>
<h1>Lot ${esc(v.lotId)}: auction check</h1>
<p class="meta">Network: ${esc(v.network)}. Servers contacted: ${esc(serversLine(v).replace(/https?:\/\//g, ""))}. This page has no scripts and loads nothing from the internet.</p>
<p class="meta">Lot key: ${v.keyFingerprint ? `accepted as read-only, fingerprint ${esc(v.keyFingerprint)}. The key itself is not in this page.` : "not used."}${v.discreet ? " Discreet mode: amounts and memos are hidden." : ""}</p>
<div class="verdict ${v.result.toLowerCase()}">${v.result === "PASS" ? `PASS: all ${v.checks.length} checks passed${v.keyLevel === "not run" ? " (basic level only)" : ""}` : `FAIL: ${v.failed.length} of ${v.checks.length} checks failed`}</div>
<p>Amounts, memos and refunds in the "From the chain" column were read from the lot's own transactions with the lot key. The bid list, winners, clearing price and refund list in the next column are what the seller published. Block heights and rules come from the seller's disclosure file.${v.scanLevel !== "not run" ? " The scan level then read every block in the lot's range with the lot key and checked those heights against the blocks the transactions were really in." : ""}</p>
<div class="wrap">${section(1)}</div>
<div class="wrap">${section(2)}</div>
${v.scanSource ? `<div class="wrap">${section(3)}</div>` : ""}
</main></body>
</html>
`;
}
