# Every check can fail

A checker that never says FAIL proves nothing. This table is made by running Imani on every round in `conformance/manifest.json` (10 honest, 42 broken copies) and on the 6 extra broken copies in `examples/checks-broken`, and recording which broken copies each check catches. Rebuild it with `node --disable-warning=ExperimentalWarning tools/check-coverage.ts --write`. A test fails if this file is out of date.

**27 of 27 checks have at least one broken copy that makes them fail.**

| Check | What it proves | Broken copies that trip it | Example |
|---|---|---|---|
| `bid-amounts` | Each bid amount matches the chain | 4 | `examples/broken/02-wrong-bid-amount` |
| `bid-count` | Bid count matches the chain | 3 | `examples/broken/01-extra-fake-bid` |
| `clearing-range` | Clearing price is between the reserve and the highest bid | 1 | `examples/pricing-broken/01-uses-the-other-price-rule` |
| `close-height` | Close height is valid | 1 | `examples/checks-broken/01-block-height-is-zero` |
| `disclosure-txids-unique` | Disclosed transaction ids are unique | 1 | `examples/checks-broken/02-same-transaction-listed-twice` |
| `goal-reached` | The goal outcome matches the listed payments | 3 | `examples/goal-broken/02-says-goal-missed-when-reached` |
| `key-hygiene` | Lot key shows only this lot's payments | 1 | `examples/checks-broken/05-key-shows-a-payment-that-is-not-a-bid` |
| `no-duplicate-bids` | No duplicate or replayed bid | 1 | `examples/checks-broken/02-same-transaction-listed-twice` |
| `no-late-bids` | No bid after the close was counted | 3 | `examples/broken/06-late-bid-counted` |
| `published-totals` | Published totals add up | 4 | `examples/totals-broken/01-keeps-more-than-the-winners-paid` |
| `published-totals-chain` | Published totals match the chain | 3 | `examples/totals-broken/01-keeps-more-than-the-winners-paid` |
| `refund-receivers` | Each refund went to the address given for its bid | 4 | `examples/memo-broken/07-refund-to-other-address` |
| `refund-total` | Refund total balances | 10 | `examples/goal-broken/01-refund-to-a-contributor` |
| `refunds-paid` | Every refund paid in the exact amount | 10 | `examples/broken/03-missing-refund` |
| `reserve` | Reserve outcome | 3 | `examples/goal-broken/02-says-goal-missed-when-reached` |
| `result-consistent` | Seller's result file is consistent with itself | 5 | `examples/goal-broken/01-refund-to-a-contributor` |
| `scan-blocks-read` | Every block in the lot's range was read | 1 | `examples/checks-broken/06-one-block-missing-from-the-scan` |
| `scan-heights` | Block heights match the chain | 1 | `examples/scan-broken/03-wrong-height` |
| `scan-hidden-bids` | No bid on the chain was left out by the seller | 2 | `examples/scan-broken/01-hidden-bid` |
| `scan-listed-in-range` | Every listed payment is in the lot's range | 1 | `examples/scan-broken/02-listed-not-in-range` |
| `scan-unlisted-payments` | No other payment of the lot was left out | 1 | `examples/testnet-broken/01-hidden-losing-bid` |
| `seal-deposits` | Every counted seal paid exactly the deposit, on time | 2 | `examples/sealed-broken/05-counts-wrong-deposit` |
| `seal-forfeits` | Seals that paid the penalty are all reported | 1 | `examples/sealed-broken/03-hides-unopened-seal` |
| `seal-openings` | Every counted bid has one matching opening | 2 | `examples/sealed-broken/01-counts-unopened-seal` |
| `txids-match-bytes` | Transaction ids match the transaction bytes | 1 | `examples/checks-broken/03-transaction-bytes-swapped` |
| `winner-count` | Winner count fits the lot | 1 | `examples/checks-broken/04-more-winners-than-items` |
| `winners-and-price` | Winners and clearing price recomputed from the chain | 9 | `examples/broken/05-wrong-clearing-price` |
