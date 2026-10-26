import { readFileSync, writeFileSync } from "node:fs";
import { checkExternalRound, externalRoundText, ExternalRoundInputError } from "../src/external/published-round.ts";
import { anchorLive, anchorRecorded, anchorText } from "../src/external/anchor.ts";

// npm run check:external -- <file>                        add up the numbers in the published file (offline)
// npm run check:external -- <file> --fetch [--save copy]  also ask two public servers for its transactions
// npm run check:external -- <file> --chain <copy>         the same chain check, read from a saved copy (offline)
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : (args[i + 1] ?? "");
};
const path = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--chain", "--save"].includes(args[i - 1])));
if (!path) {
  console.error("Usage: npm run check:external -- <reveal.json or settlement.json> [--fetch [--save <file>] | --chain <file>]");
  process.exit(2);
}
try {
  const file = JSON.parse(readFileSync(path, "utf8"));
  const report = checkExternalRound(file);
  console.log(externalRoundText(report));
  let ok = report.result === "PASS";
  if (args.includes("--fetch")) {
    const { report: a, recorded } = await anchorLive(file);
    console.log("\n" + anchorText(a));
    const save = flag("--save");
    if (save) {
      writeFileSync(save, JSON.stringify(recorded, null, 2) + "\n");
      console.log(`Saved a copy of the fetched transactions to ${save}`);
    }
    ok = ok && a.result === "PASS";
  } else if (flag("--chain")) {
    const a = anchorRecorded(file, JSON.parse(readFileSync(flag("--chain")!, "utf8")));
    console.log("\n" + anchorText(a));
    ok = ok && a.result === "PASS";
  }
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(e instanceof ExternalRoundInputError ? `Input error: ${e.message}` : "Input error: cannot read that file as JSON.");
  process.exit(2);
}
