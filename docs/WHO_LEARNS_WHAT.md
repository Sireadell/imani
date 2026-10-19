# Who learns what

Worked out by `src/privacy/who-learns.ts` from the real round in `examples/testnet-01` (lot DRY-01, Zcash test network), not typed by hand. `npm run who-learns` writes this table and the one on the checker page, and a test fails if either drifts from the code.

| Who | Learns | Cannot learn |
|---|---|---|
| Anyone, without the lot key | That 80 shielded transactions in 34 blocks happened, and their fees | Any amount, memo or address, or even which 6 belong to this auction |
| Anyone, once the seller publishes the lot key | The 3 bid amounts, their memos with each bidder's refund address, the 3 refunds and which bid each one pays back | Who the bidders are, what else is in their wallets, or any payment outside this auction. Refund links that reach outside the round: 0 |
| The seller | Each bid as it arrives, because the lot key is the seller's | Anything else in the bidders' wallets. The seller can see bids early, which the check cannot rule out |
| Each bidder | Their own bid and refund, and after the close everything the lot key shows | Other bidders' wallets or identities |
| The checker page and its host | That the page was downloaded | Anything you check here: the checker page makes no network calls after it loads |
| The "Check any round" page, its host and two public Zcash servers | Only after you press the button that names them: which block numbers you asked for. The host also sees your IP address, as any website does | Your viewing key, or any amount, memo or address: the key never leaves your browser tab, and the blocks are read there. A saved block file sends nothing at all |

How far a refund can be followed in any round: `npx imani linking <disclosure.json> [more disclosures]`.

## Sealed lots

| Who | Learns before the close | Learns after the close |
|---|---|---|
| The seller | How many deposits arrived and in which blocks. Every deposit is the same amount and every memo is a 64-character code | Prices, as bidders open them. The seller cannot add a new seal any more |
| Anyone without the lot key | Nothing new: the payments are shielded | Nothing new |
| Anyone with the published lot key | Everything the lot key shows, as today | Everything the lot key shows, as today |
