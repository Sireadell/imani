# How big a round can it check?

A big public auction can draw thousands of bids. This page says what Imani does with a round of 19,000 bid payments, what was measured, and what was not. That round is generated to the published size: made-up amounts built from a fixed seed, not real payments.

## What was run

| Part | Size | Result | Real or generated |
|---|---|---|---|
| The seller's two files: bids, winners, price, refunds, published totals, checked against each other and against the published rules (basic level) | 19,000 bid payments (18,971 counted, 29 late), 5,000 items, lowest-winning price | Passes in about 50 milliseconds. Any one of seven changes (a bid left out, one refund 1 zatoshi off, the price 1 zatoshi off, a total off by 1, a winner dropped and so on) makes it fail | Generated with a fixed seed. These are made-up amounts, not real payments |
| Reading real transactions with a viewing key (key level) | 600 real test-network transactions, read one after another | 16.8 milliseconds each on a laptop, so 19,000 transactions would take about 5 minutes. This is an estimate from the per-transaction time, not a run of 19,000 | Real transactions, repeated |
| Reading real blocks from a public server (scan level) | 500 real mainnet blocks (3,509,100 to 3,509,599), holding 2,893 transactions | Measured on 2026-10-07 with a public test key that owns nothing, so nothing was decrypted. Download took 1,366 seconds with 12 blocks at a time, about 2.7 seconds per block, and 28.4 MB. Reading every transaction with the key took 27 seconds, and 0 transactions were unreadable. Mainnet makes one block every 75 seconds, so a day-long auction is about 1,150 blocks: at this rate about 52 minutes and about 65 MB. Full table in [SPEC.md](../SPEC.md), section "Speed and cost". Re-run with `tools/measure-scan.ts` (only when you set `LIVE=1`) | Real |

Run the first row yourself: `npx tsx --test test/scale.test.ts` (it prints the time). Run the second on any machine with `npm run test` once you have a lot of your own.

## What this does not show

- A 19,000-bid round of real encrypted payments was not built, so the key level was not run end to end at that size. What is measured is the cost per transaction.
- The generated round proves that the seller-file checks and the totals stay fast and exact at that size. It does not prove anything about a real auction's payments.
- Imani has not been run on the payments of a real auction this size. The round is bigger than the 16,971 bids reported for a big public auction, but that is a comparison of sizes only: nothing here was checked against that auction's own data.

## A mainnet-sized check

What a small real-money round and a day-long auction cover, using only saved timings. Sources: the "Speed and cost" table in [SPEC.md](../SPEC.md) (500 real mainnet blocks, measured 2026-10-07) and a short mainnet timing (5 mainnet blocks in 13 seconds, measured 2026-10-27).

| What | Blocks | Bids | Check time | Where the number comes from |
|---|---|---|---|---|
| Small mainnet round (lot IMANI-M1): opens, closes 20 blocks later, refunds due 40 blocks after that | 60 | 3 bids, 3 refunds | About 3 minutes per download, at about 2.6 seconds per block. This is the per-block rate multiplied out, not a run of 60 blocks | The 5-block timing above |
| Measured real-block stretch | 500 | Not applicable (a stranger key, nothing decrypted) | 1,366 seconds to download (about 2.7 seconds per block), 27 seconds to read 2,893 transactions | SPEC.md, "Speed and cost" |
| Day-long mainnet auction | About 1,150 (one block every 75 seconds) | Not measured | About 52 minutes and about 65 MB at the 500-block rate | SPEC.md, "Speed and cost" |
| The basic level at 19,000 bid payments (generated) | Not applicable | 19,000 | About 50 milliseconds | The table above, `test/scale.test.ts` |

## What is still unmeasured

- The small mainnet round has been run (see [examples/mainnet-01](../examples/mainnet-01/README.md)), but no check time was recorded for it. The 3 minute figure is the 5-block rate multiplied out.
- No check has been timed on the bids of a real mainnet auction with thousands of bids. Bids per day-long auction: not measured.
- The 5-block timing is from one short run on one day. The 500-block run is the longer measurement.
- Download time depends on how busy the public servers are. Other times and other machines: not measured.

## Published totals

Big auctions are reported as a few headline numbers. A result file can carry `totals`: the number of payments, the amount received, kept and refunded. The check `published-totals` adds them up (received must equal kept plus refunded), compares kept with what the winners pay and refunded with the refund list, and checks the payment count is not lower than the bids and late payments the seller lists. The check `published-totals-chain` compares all four figures with what the lot key reads from the chain. Example: `examples/totals-01` and four broken copies in `examples/totals-broken/`.
