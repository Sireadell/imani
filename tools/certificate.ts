// The printable fairness certificate: one page per checked round, made at site build time from the
// same rows as the checked-rounds list (so the numbers come from the real checker, never typed in).
// No script, no network, and no key of any kind appears on the page.
import { readFileSync } from "node:fs";
import { exampleData, listOnlyData } from "./site-build.ts";
import { roundRows, type RoundRow } from "./rounds-list.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function certificateFile(id: string): string {
  return `certificate-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}.html`;
}

function version(): string {
  const v = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").slice(0, 7);
  return sha ? `Imani ${v}, commit ${sha}` : `Imani ${v}`;
}

function networkName(n: string): string {
  if (n === "test") return "Zcash test network";
  if (n === "main") return "Zcash mainnet";
  return n;
}

export interface CertificateFacts {
  lot: string;
  bids: string;
}

/** Lot name and bid count for a row, read from the round's own files. */
export function certificateFacts(rows: RoundRow[] = roundRows()): Map<string, CertificateFacts> {
  const data = exampleData();
  const extra = listOnlyData();
  const { externals } = data;
  const blobs = { ...data.blobs, ...extra.blobs };
  const out = new Map<string, CertificateFacts>();
  for (const e of [...data.entries, ...extra.entries]) {
    const d = JSON.parse(blobs[e.disclosure]);
    const r = JSON.parse(blobs[e.result]);
    out.set(e.id, { lot: String(d.lotId ?? "not stated"), bids: Number.isSafeInteger(r.bidCount) ? String(r.bidCount) : "not stated" });
  }
  for (const x of externals) {
    const f = JSON.parse(blobs[x.blob]);
    out.set(x.id, { lot: String(f.lot_id ?? f.lot ?? "not stated"), bids: "not stated in the file" });
  }
  for (const r of rows) if (!out.has(r.id)) out.set(r.id, { lot: "not stated", bids: "not stated" });
  return out;
}

export function certificatePage(r: RoundRow, f: CertificateFacts): string {
  const pass = r.result === "PASS";
  const rows: [string, string][] = [
    ["Round", r.id],
    ["Lot", f.lot],
    ["Network", networkName(r.network)],
    ["Blocks read", r.blocks],
    ["Bids", f.bids],
    ["Checks passed", `${r.passed} of ${r.total}`],
    ["Verdict", r.result],
    ...(pass ? [] : ([["Failed checks", r.failing.join(", ")]] as [string, string][])),
    ["Checked with", version()],
    ["Date of this page", r.checked],
  ];
  const trs = rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td${k === "Verdict" ? ` class="${pass ? "pass" : "fail"}"` : ""}>${esc(v)}</td></tr>`).join("\n");
  const q = encodeURIComponent(r.id);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Fairness certificate ${esc(r.id)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="certificate.css">
</head>
<body>
<main class="sheet">
  <h1>Fairness certificate</h1>
  <p class="lead">This page records one check of one auction round. You don't have to trust it: anyone can run the same check and should get the same answer.</p>
  <table>
${trs}
  </table>
  <div class="stamp ${pass ? "pass" : "fail"}"><div><div class="k">Verdict</div><div class="big">${pass ? "FAIR" : "NOT FAIR"}</div></div><div class="count"><div class="n">${esc(`${r.passed} of ${r.total}`)}</div><div>checks passed</div></div></div>
  <h2>How to re-check</h2>
  <p>To check it again yourself, open <strong>imani-check.vercel.app/?round=${esc(q)}</strong> and press "Check it yourself". It runs on your computer and sends nothing. Or, with Node 22 installed and this project downloaded, run: <code>node bin/imani.js check --disclosure examples/${esc(r.id)}/disclosure.json --result examples/${esc(r.id)}/result.json</code>.</p>
  <p class="foot">Imani checks the result. It never holds money and does not run auctions. It can't prove the seller didn't look at bids as they arrived.</p>
  <p class="noprint"><a href="rounds.html">Back to the checked rounds</a> &middot; <button type="button" onclick="window.print()" hidden>Print</button></p>
</main>
</body>
</html>
`;
}

export function allCertificates(): { file: string; html: string }[] {
  const rows = roundRows();
  const facts = certificateFacts(rows);
  return rows.map((r) => ({ file: certificateFile(r.id), html: certificatePage(r, facts.get(r.id)!) }));
}
