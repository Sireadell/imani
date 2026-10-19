# Who learns what

Worked out by `src/privacy/who-learns.ts` from the real round in `examples/testnet-01` (lot DRY-01, Zcash test network), not typed by hand. `npm run who-learns` writes this table and the one on the checker page, and a test fails if either drifts from the code.

| Who | Learns | Cannot learn |
|---|---|---|
| Anyone, without the lot key | That 80 shielded transactions in 34 blocks happened, and their fees | Any amount, memo or address, or even which 6 belong to this auction |
| Anyone, once the seller publishes the lot key | The 3 bid amounts, their memos with each bidder's refund address, the 3 refunds and which bid each one pays back | Who the bidders are, what else is in their wallets, or any payment outside this auction. Refund links that reach outside the round: 0 |
| The seller | Each bid as it arrives, because the lot key is the seller's | Anything else in the bidders' wallets. The seller can see bids early, which the check cannot rule out |
| Each bidder | Their own bid and refund, and after the close everything the lot key shows | Other bidders' wallets or identities |
| This page and its host | That the page was downloaded | Anything you check here: the page makes no network calls after it loads |

How far a refund can be followed in any round: `npx imani linking <disclosure.json> [more disclosures]`.
