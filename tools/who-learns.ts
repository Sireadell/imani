// Writes the "who learns what" table for the real test-network round into the docs and the page.
// Run: npm run who-learns
import { readFileSync, writeFileSync } from "node:fs";
import { whoLearns, whoLearnsMarkdown } from "../src/privacy/who-learns.ts";

const root = new URL("../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const rep = whoLearns(json("examples/testnet-01/disclosure.json"), json("examples/testnet-01/chain.json"));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const doc = `# Who learns what

Worked out by \`src/privacy/who-learns.ts\` from the real round in \`examples/testnet-01\` (lot ${rep.lotId}, Zcash test network), not typed by hand. \`npm run who-learns\` writes this table and the one on the checker page, and a test fails if either drifts from the code.

${whoLearnsMarkdown(rep)}
How far a refund can be followed in any round: \`npx imani linking <disclosure.json> [more disclosures]\`.

## Sealed lots

| Who | Learns before the close | Learns after the close |
|---|---|---|
| The seller | How many deposits arrived and in which blocks. Every deposit is the same amount and every memo is a 64-character code | Prices, as bidders open them. The seller cannot add a new seal any more |
| Anyone without the lot key | Nothing new: the payments are shielded | Nothing new |
| Anyone with the published lot key | Everything the lot key shows, as today | Everything the lot key shows, as today |
`;
writeFileSync(new URL("docs/WHO_LEARNS_WHAT.md", root), doc);

const pagePath = new URL("src/site/static/index.html", root);
const page = readFileSync(pagePath, "utf8");
const start = "<!-- who-learns:start -->";
const end = "<!-- who-learns:end -->";
const a = page.indexOf(start);
const b = page.indexOf(end);
if (a < 0 || b < a) throw new Error("index.html has no who-learns markers");
const rows = rep.rows.map((r) => `      <tr><th scope="row">${esc(r.party)}</th><td>${esc(r.learns)}</td><td>${esc(r.cannotLearn)}</td></tr>`).join("\n");
const table = `${start}
    <table class="who">
      <thead><tr><th scope="col">Who</th><th scope="col">Learns</th><th scope="col">Cannot learn</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    ${end}`;
writeFileSync(pagePath, page.slice(0, a) + table + page.slice(b + end.length));
console.log(`Wrote docs/WHO_LEARNS_WHAT.md and the page table (${rep.rows.length} rows, from ${rep.blocks} blocks).`);
