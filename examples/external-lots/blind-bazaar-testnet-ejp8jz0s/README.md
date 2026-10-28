# Blind Bazaar, lot ejp8jz0s: re-read from the chain

[Blind Bazaar](https://github.com/Don-Vicks/blind-bazaar) is another Zcash sealed-bid auction project (MIT licence). On 22 Oct 2026 it ran a lot on the public Zcash test network and published the lot's read-only viewing key, both bids' reveals and its result (`docs/evidence/testnet-ejp8jz0s/` in its repository). Imani is a neutral checker, so this folder shows it re-checking that lot from the chain without trusting the project's server.

```sh
npm run check:blind-bazaar
```

Expected: `RESULT: PASS (6 of 6 checks passed)`. Check their own tampered file:

```sh
npm run check:blind-bazaar -- --result examples/external-lots/blind-bazaar-testnet-ejp8jz0s/result-tampered.json
```

Expected: `RESULT: FAIL (5 of 6 checks passed)`, failing on the winner and price.

## What it does

1. Reads all 63 blocks from 4,530,063 to 4,530,125 with the viewing key the project published. Two public servers run by different people returned the same bytes for every block (`chain.json`).
2. Finds exactly 2 payments, in blocks 4,530,073 and 4,530,076, of 1,000,000 zatoshis each (the deposit), both before the close at block 4,530,107. Their memos hold commitments, not prices.
3. Checks that each published reveal opens a commitment: `sha256("ejp8jz0s|<bid in zatoshis>|<salt>")` equals the commitment in a memo.
4. Applies the project's rule (one item, first price): the highest revealed bid at or above the reserve wins and pays its own bid. The chain gives 3,000,000 zatoshis and transaction `59ec5bba2a...`, the same as the project published.

## Limits

- Refunds, the sweep and the payout are paid from the project's operator wallet, which the lot key cannot see, so they are not checked.
- The commitment format was worked out from the project's description and checked against its two published reveals. It is not a reading of its source code.
- This applies the project's published rules. Imani does not run, host or judge that project, and the project has not reviewed this.
- Files: `lot.json`, `result.json` and `result-tampered.json` are the project's own published files, unchanged. `chain.json` is made by `node tools/make-blind-bazaar-example.ts`.
