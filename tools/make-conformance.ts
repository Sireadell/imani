// Writes conformance/manifest.json: every passing round and every broken copy under examples/,
// with the verdict a correct checker must give. Run: npm run conformance:make
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface Case {
  id: string;
  kind: "honest" | "broken";
  disclosure: string;
  result: string;
  /** Present when the case is checked with a full scan of a chain file (--scan --chain). */
  chain?: string;
  expect: "PASS" | "FAIL";
  /** Broken copies: every check a correct checker must name as failed. */
  failing?: string[];
  story?: string;
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// Honest rounds. A round with `scan` is also checked with a full scan of its chain file.
const honest: { dir: string; scan?: string }[] = [
  { dir: "round-01" },
  { dir: "memo-01" },
  { dir: "receivers-01" },
  { dir: "scan-01", scan: "examples/scan-01/chain.json" },
  { dir: "goal-reached" },
  { dir: "goal-missed" },
  { dir: "pricing-01" },
  { dir: "totals-01" },
  { dir: "sealed-01" },
  { dir: "testnet-01", scan: "examples/testnet-01/chain.json" },
  { dir: "mainnet-01", scan: "examples/mainnet-01/chain.json" },
  { dir: "formats-01/second-price" },
  { dir: "formats-01/first-price" },
  { dir: "formats-01/top-up" },
];
// Broken copies. `chain` is the chain file to scan with, or "own" when each copy carries its own.
// A copy that changes only one file leaves the other out; it then uses the honest round's file (`base`).
const broken: { dir: string; chain?: string; base?: string }[] = [
  { dir: "broken" },
  { dir: "memo-broken" },
  { dir: "receivers-broken" },
  { dir: "goal-broken" },
  { dir: "pricing-broken" },
  { dir: "totals-broken" },
  { dir: "sealed-broken" },
  { dir: "scan-broken", chain: "own" },
  { dir: "testnet-broken", chain: "examples/testnet-01/chain.json", base: "testnet-01" },
  { dir: "mainnet-broken", chain: "examples/mainnet-01/chain.json", base: "mainnet-01" },
  { dir: "checks-broken" },
  { dir: "formats-01" },
];

const cases: Case[] = [];
for (const h of honest) {
  const base = `examples/${h.dir}`;
  cases.push({ id: h.dir, kind: "honest", disclosure: `${base}/disclosure.json`, result: `${base}/result.json`, ...(h.scan ? { chain: h.scan } : {}), expect: "PASS" });
}
for (const b of broken) {
  const manifest = read(`examples/${b.dir}/manifest.json`);
  for (const c of manifest.copies) {
    const base = `examples/${b.dir}/${c.name}`;
    const failing: string[] = c.expectedFailingChecks ?? [c.expectedFailingCheck];
    // A copy that names its own chain file in its manifest entry uses that one.
    const chain = c.chain ? `${base}/${c.chain}` : b.chain === "own" ? `${base}/chain.json` : b.chain;
    if (chain && !existsSync(chain)) throw new Error(`missing ${chain}`);
    const file = (name: string) => (existsSync(`${base}/${name}`) ? `${base}/${name}` : b.base ? `examples/${b.base}/${name}` : (() => { throw new Error(`missing ${base}/${name}`); })());
    cases.push({ id: `${b.dir}/${c.name}`, kind: "broken", disclosure: file("disclosure.json"), result: file("result.json"), ...(chain ? { chain } : {}), expect: "FAIL", failing, story: c.story });
  }
}
const out = {
  format: "imani-conformance/1",
  about: "Every passing round and every broken copy in examples/. A correct checker must say PASS for each honest case, and FAIL for each broken case, naming every check in `failing`.",
  honest: cases.filter((c) => c.kind === "honest").length,
  broken: cases.filter((c) => c.kind === "broken").length,
  cases,
};
writeFileSync("conformance/manifest.json", JSON.stringify(out, null, 2) + "\n");
console.log(`conformance/manifest.json: ${out.honest} honest rounds, ${out.broken} broken copies`);
