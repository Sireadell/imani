// Re-checks a saved lot of the Blind Bazaar project from the chain (see src/external/blind-bazaar.ts).
//   node --disable-warning=ExperimentalWarning tools/check-blind-bazaar.ts [--result <file>]
// Defaults to the honest result in examples/external-lots/blind-bazaar-testnet-ejp8jz0s. Exit 0 PASS, 1 FAIL, 2 bad input.
import { readFileSync } from "node:fs";
import { BlindBazaarInputError, blindBazaarText, checkBlindBazaarLot } from "../src/external/blind-bazaar.ts";

const dir = new URL("../examples/external-lots/blind-bazaar-testnet-ejp8jz0s/", import.meta.url);
const i = process.argv.indexOf("--result");
const resultPath = i > 0 ? process.argv[i + 1] : new URL("result.json", dir).pathname;
const read = (p: string | URL) => JSON.parse(readFileSync(p, "utf8"));
try {
  const report = checkBlindBazaarLot(read(new URL("lot.json", dir)), read(resultPath), read(new URL("chain.json", dir)));
  console.log(blindBazaarText(report));
  process.exit(report.result === "PASS" ? 0 : 1);
} catch (e) {
  console.error(e instanceof BlindBazaarInputError ? `Input error: ${e.message}` : `Input error: ${(e as Error).message}`);
  process.exit(2);
}
