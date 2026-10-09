// Run the login scorecard against the two logins in this repo and print both cards.
//   npm run login:scorecard           prints the cards
//   npm run login:scorecard -- --json prints them as JSON
// Exit code 0 when imani's own card has no failure and the weak example fails as it should, else 1.
import { runScorecard, scorecardText } from "../src/login/index.ts";
import { imaniUnderTest, weakUnderTest } from "./scorecard-adapters.ts";

const cards = [await runScorecard(imaniUnderTest()), await runScorecard(weakUnderTest())];
if (process.argv.includes("--json")) console.log(JSON.stringify(cards, null, 2));
else console.log(cards.map(scorecardText).join("\n\n"));
process.exitCode = cards[0].failed === 0 && cards[1].failed > 0 ? 0 : 1;
