// npm run demo: check the honest round (PASS), a tampered copy (FAIL), then a seller who hid a
// bid, which only the full-range scan catches (FAIL). Offline, no server contacted.
import { run } from "../src/cli.ts";

const show = (title: string, dir: string, scan = false) => {
  const args = ["check", "--disclosure", `examples/${dir}/disclosure.json`, "--result", `examples/${dir}/result.json`];
  if (scan) args.push("--scan", "--chain", `examples/${dir}/chain.json`);
  console.log(`\n=== ${title} ===\n$ imani ${args.join(" ")}\n`);
  const res = run(args);
  console.log(res.stdout || res.stderr);
  return res.code;
};

const a = show("1. The honest round", "round-01");
const b = show("2. The same round, but the seller under-refunded a losing bidder", "broken/04-short-refund");
const c = show("3. Hidden bid caught: the seller left a 3,000,000 bid out of both files", "scan-broken/01-hidden-bid", true);
if (a !== 0 || b !== 1 || c !== 1) {
  console.error("Demo did not give PASS, FAIL, FAIL.");
  process.exitCode = 1;
} else {
  console.log("\nDemo finished: round-01 PASS, tampered copy FAIL, hidden bid caught by the scan level.");
}
