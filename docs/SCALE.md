# How big a round can it check?

There was a 16,971-bid sealed auction on Zcash this year. This page says what Imani does at that size, what was measured, and what was not.

## What was run

| Part | Size | Result | Real or generated |
|---|---|---|---|
| The seller's two files: bids, winners, price, refunds, published totals, checked against each other and against the published rules (basic level) | 17,000 bid payments (16,971 counted, 29 late), 5,000 items, lowest-winning price | Passes in about 50 milliseconds. Any one of seven changes (a bid left out, one refund 1 zatoshi off, the price 1 zatoshi off, a total off by 1, a winner dropped and so on) makes it fail | Generated with a fixed seed. These are made-up amounts, not real payments |
| Reading real transactions with a viewing key (key level) | 600 real test-network transactions, read one after another | 16.8 milliseconds each on a laptop, so 17,000 transactions would take about 5 minutes. This is an estimate from the per-transaction time, not a run of 17,000 | Real transactions, repeated |
| Reading real blocks from a public server (scan level) | 500 real mainnet blocks | See `tools/measure-scan.ts`, which times the download and the reading. It runs only when you set `LIVE=1` | Real |

Run the first row yourself: `npx tsx --test test/scale.test.ts` (it prints the time). Run the second on any machine with `npm run test` once you have a lot of your own.

## What this does not show

- A 17,000-bid round of real encrypted payments was not built, so the key level was not run end to end at that size. What is measured is the cost per transaction.
- The generated round proves that the seller-file checks and the totals stay fast and exact at that size. It does not prove anything about a real auction's payments.
- The 16,971-bid sealed auction on Zcash this year is the size we aimed at. Imani has not been run on its data.

## Published totals

Big auctions are reported as a few headline numbers. A result file can carry `totals`: the number of payments, the amount received, kept and refunded. The check `published-totals` adds them up (received must equal kept plus refunded), compares kept with what the winners pay and refunded with the refund list, and checks the payment count is not lower than the bids and late payments the seller lists. The check `published-totals-chain` compares all four figures with what the lot key reads from the chain. Example: `examples/totals-01` and four broken copies in `examples/totals-broken/`.
