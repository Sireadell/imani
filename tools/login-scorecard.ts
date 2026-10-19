// Run the login scorecard against the two logins in this repo and print both cards.
//   npm run login:scorecard           prints the cards
//   npm run login:scorecard -- --json prints them as JSON
// Exit code 0 when imani's own card has no failure and the weak example fails as it should, else 1.
import { runScorecard, scorecardText } from "../src/login/index.ts";
import { imaniUnderTest, weakUnderTest } from "./scorecard-adapters.ts";

const cards = [await runScorecard(imaniUnderTest()), await runScorecard(weakUnderTest())];
const ok = cards[0].failed === 0 && cards[1].failed > 0;
const of = (c: (typeof cards)[number]) => `${c.passed} of ${c.passed + c.failed}`;
if (process.argv.includes("--json")) console.log(JSON.stringify(cards, null, 2));
else {
  console.log(cards.map(scorecardText).join("\n\n"));
  // The weak card's own last line is a FAIL by design, so end on one line about both cards.
  console.log(`\nSCORECARD ${ok ? "OK" : "NOT OK"}: this repo's login passes ${of(cards[0])}. The weak example, written to show what the checks catch, passes ${of(cards[1])}.`);
}
process.exitCode = ok ? 0 : 1;
