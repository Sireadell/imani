// npm run demo: check the honest round (PASS), then a tampered copy (FAIL).
import { run } from "../src/cli.ts";

const show = (title: string, dir: string) => {
  console.log(`\n=== ${title} ===\n$ imani check --disclosure examples/${dir}/disclosure.json --result examples/${dir}/result.json\n`);
  const res = run(["check", "--disclosure", `examples/${dir}/disclosure.json`, "--result", `examples/${dir}/result.json`]);
  console.log(res.stdout || res.stderr);
  return res.code;
};

const a = show("1. The honest round", "round-01");
const b = show("2. The same round, but the seller under-refunded a losing bidder", "broken/04-short-refund");
if (a !== 0 || b !== 1) {
  console.error("Demo did not give PASS then FAIL.");
  process.exitCode = 1;
} else {
  console.log("\nDemo finished: round-01 PASS, tampered copy FAIL.");
}
