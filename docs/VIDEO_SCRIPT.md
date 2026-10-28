# Demo video script (about 2 minutes)

Record the terminal full screen, font large. Every command below was run and gave the output shown. Say the quoted lines; the rest is what to do on screen.
Before you start: `npm install`, `npm run build`, and clear the terminal.

## 0:00 to 0:15, the problem

**Screen:** the README top.
**Say:** "In a sealed-bid auction on Zcash, the seller says who won. Everything is private, so how do you know they were honest? Imani checks the seller's answer against the chain."

## 0:15 to 0:45, honest, cheat, hidden bid

**Run:** `npm run demo`
**Show:** three results, one after another.
**Say:** "Three versions of one small auction. The honest one passes. In the second, the seller refunded a loser 100,000 zatoshis short, and Imani fails it, names the check, `refunds-paid`, and prints what to do next. In the third, the seller left a 3,000,000 bid out of their files. Imani reads every block of the auction and finds it: `scan-hidden-bids`."

## 0:45 to 1:10, a real round, and privacy

**Run:** `node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --offline --discreet`
**Show:** `Servers contacted: none` and `RESULT: PASS (16 of 16 checks passed)`.
**Say:** "A real round on the Zcash test network. No servers, no amounts, no memos or addresses printed, and the key is read-only."
**Run:** `node bin/imani.js linking examples/testnet-01/disclosure.json`
**Show:** `RESULT: NO LINKS OUTSIDE THE ROUND`.
**Say:** "It also checks that the auction did not leak. No refund can be followed past its own bid. It notes memos that give too much away, refunds a stranger could match by timing, transparent parts and tied bids."

## 1:10 to 1:30, bidders and real money

**Run:** `node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --mine 2f5e8f4f37`
**Show:** `Your bid: counted, 1,500,000 zat.`
**Say:** "A bidder can ask 'was my bid counted?' We also ran a small mainnet auction with real ZEC. Here is the bid link scanned in ZODL."
**Show:** the ZODL scan of the mainnet bid link (docs/BID_LINK.md).

## 1:30 to 1:50, how we know the checker is honest

**Show:** `docs/CHECK_COVERAGE.md`, scroll through it.
**Say:** "We tested it 66 ways: 14 honest rounds that must pass and 52 with a cheat built in that must fail. All 27 checks have a cheat that makes them fail, so none is for show. A second checker, written separately in Python, agrees on every round it can decide."

## 1:50 to 2:10, another project, and the honest limit

**Run:** `npm run check:blind-bazaar`
**Show:** `RESULT: PASS (6 of 6 checks passed)`.
**Say:** "We re-read a real lot from Blind Bazaar and got the winner and price they published. We are not connected to them, and this is a re-read, not an audit. Refunds are outside what their key shows."
**Say:** "Imani can't force a seller to open up. It makes opening up cheap, and it makes a refusal visible. Next: bidder tools on a real wallet, a live Zebra node, and readers for more projects."

## Optional shots (every command below was run and gave the output shown)

Cut these first if you need to stay near 2:00. Each takes about 10 seconds.

**More ways a seller can cheat.** Run each, show only the last line:
- `node bin/imani.js check --disclosure examples/broken/01-extra-fake-bid/disclosure.json --result examples/broken/01-extra-fake-bid/result.json --offline` gives `RESULT: FAIL (1 of 15 checks failed: bid-count)`.
- The same command with `05-wrong-clearing-price` gives `FAIL ... winners-and-price`.
- The same with `06-late-bid-counted` gives `FAIL ... no-late-bids`.
**Say:** "Each cheat changes one fact. Imani names the exact check that caught it and says what to do next."

**A leaky round.** `node bin/imani.js linking examples/memo-01/disclosure.json`
**Show:** `note: 8 payment(s) use a transparent input or output`, and the timing note.
**Say:** "Here the privacy checks flag a round that leaks: payments with public parts, and refunds a stranger could pair with bids by order."

**The browser page.** Open https://imani-check.vercel.app. It opens on the real mainnet round.
**Say:** "The same check runs in the browser, on the real mainnet auction."

## Don't say

- That we read other projects' auctions in general.
- That Imani is the most tested entry in the track.
- That it matches LeakBench. We cover six auction-specific leak checks (no fee check), not 15.
- That `bidder-check` has been run on a real wallet. It has not.
