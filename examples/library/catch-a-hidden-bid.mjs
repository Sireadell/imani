// Read every block of a round with the lot key, from code, to catch a bid the seller left out.
// Run from the repo root after `npm run build`:
//   node examples/library/catch-a-hidden-bid.mjs           saved blocks, no network
//   node examples/library/catch-a-hidden-bid.mjs --fetch   the real test-network round, downloaded live
// In your own project, after installing imani, import from "@sireadell/imani" instead.
import { readFileSync } from "node:fs";
import { checkLot, scanFromChain, fetchScan } from "../../dist/index.js";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

async function check(dir) {
  const disclosure = read(`${dir}/disclosure.json`);
  const scan = process.argv.includes("--fetch") ? await fetchScan(disclosure) : scanFromChain(disclosure, read(`${dir}/chain.json`));
  const v = checkLot(disclosure, read(`${dir}/result.json`), { scan });
  console.log(`${dir}: ${v.result} (${v.checks.length - v.failed.length} of ${v.checks.length} checks passed)${v.failed.length ? `, failed: ${v.failed.join(", ")}` : ""}`);
}

await check("testnet-01");
// The same round shape with a 3,000,000 zatoshi bid left out of both seller files. Only saved blocks exist for it.
if (!process.argv.includes("--fetch")) await check("scan-broken/01-hidden-bid");
