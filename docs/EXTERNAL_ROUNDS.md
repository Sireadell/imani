# Recomputing a round imani did not run

Another Zcash sealed-bid auction project publishes the result of each round as JSON files. `src/external/published-round.ts` reads one of those files and recomputes the round. The format and the round files used in the tests are credited in `THIRD_PARTY.md`. No code was copied.

```sh
npm run check:external -- test/external/round-files/demo01-settlement.json
npm run check:external -- test/external/round-files/tampered.json
```

Servers contacted: none. Exit code 0 PASS, 1 FAIL, 2 bad input.

## What it checks

That format prices a round at the lowest winning bid, so this reader uses that rule. Imani's own rule is different (the highest losing bid), which is why this lives in its own file and does not use `src/rules.ts`.

| Check | Both files | Settlement files | Reveal files |
|---|---|---|---|
| Every bid listed once | yes | | |
| Winners are the highest bids at or above the reserve (a tie at the edge needs no tie rule) | yes | | |
| Price equals the lowest winning bid | yes | | |
| Each row pays and gets back the right amounts | | yes | |
| Stated totals match the rows | | yes | |
| Stated bid count matches the rows | | yes | |
| Every losing bid is refunded exactly what it paid | | | yes |
| No winner is also refunded their whole bid | | | yes |

## What we saw (checked 2026-10-09)

| File | Result |
|---|---|
| `demo01-settlement.json`, a real mainnet round | PASS, 6 of 6. The file says the lot wallet held 0.0218 ZEC while the bids add up to 0.025. The file does not explain the difference and the reader does not use it. |
| `reveal.json`, a made-up round | PASS |
| `tampered.json`, the same made-up round with one bid changed from 1.55 to 1.50 | FAIL: the refund list still says 1.55 for that bid. |

## Limits

- This reads numbers a seller wrote down. It does not show that those amounts are what was paid on the chain. These files carry transaction ids but not the transactions, and the lot key is not public, so imani's key level and scan level cannot run on these rounds.
- It does not check when amounts became public, or whether a commitment was published before the reveal.
- It was tested on the three files above, and has not been run on any other round in this format.
