// Check a real round with the imani library. Run from the repo root after `npm run build`:
//   node examples/library/check-a-round.mjs
// In your own project, after installing imani, import from "@sireadell/imani" instead.
import { readFileSync } from "node:fs";
import { checkLot } from "../../dist/index.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../testnet-01/${name}`, import.meta.url), "utf8"));
const verdict = checkLot(read("disclosure.json"), read("result.json"));
console.log(`${verdict.lotId}: ${verdict.result} (${verdict.checks.length - verdict.failed.length} of ${verdict.checks.length} checks passed)`);
for (const id of verdict.failed) console.log(`failed: ${id}`);
