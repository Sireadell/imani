import { readFileSync } from "node:fs";
import { checkExternalRound, externalRoundText, ExternalRoundInputError } from "../src/external/published-round.ts";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run check:external -- <reveal.json or settlement.json>");
  process.exit(2);
}
try {
  const report = checkExternalRound(JSON.parse(readFileSync(path, "utf8")));
  console.log(externalRoundText(report));
  process.exit(report.result === "PASS" ? 0 : 1);
} catch (e) {
  console.error(e instanceof ExternalRoundInputError ? `Input error: ${e.message}` : "Input error: cannot read that file as JSON.");
  process.exit(2);
}
