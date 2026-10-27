# Threat table

Who might cheat in a round, what they could try, and which Imani check catches it. Each check id is the name Imani prints next to PASS or FAIL. Check ids come from `src/check.ts` (basic and key level) and `src/scan/scan.ts` (scan level, needs `--scan`). Where a row is not caught, it says so in one sentence.

Four people are in this table:

- **Dishonest seller**: runs the lot, holds the lot key and publishes the two files.
- **Dishonest bidder**: pays a bid, or anyone else who can pay into the lot address.
- **Lying block server**: a server that hands Imani the blocks when you use `--fetch`, or whoever gave you a saved chain file.
- **Lot-key holder**: anyone who has the lot's read-only viewing key, which is everyone once the seller publishes it.

| Who | What they could try | What catches it | Proof |
|---|---|---|---|
| Seller | List a bid that was never paid, to push the price up | `bid-count` | `examples/broken/01-extra-fake-bid` |
| Seller | Change the amount of a real bid | `bid-amounts` | `examples/broken/02-wrong-bid-amount` |
| Seller | Skip a refund, or pay one short | `refunds-paid` | `examples/broken/03-missing-refund`, `examples/broken/04-short-refund` |
| Seller | Charge winners a higher price than the rule gives | `winners-and-price` | `examples/broken/05-wrong-clearing-price` |
| Seller | Count a bid that arrived after the close | `no-late-bids` | `examples/broken/06-late-bid-counted` |
| Seller | Say the reserve was or was not met when the chain says otherwise | `reserve` | Recomputed from the on-time bids in `src/check.ts` |
| Seller | Leave a bid out of the files entirely and keep the money | `scan-hidden-bids` (with `--scan`). The key level alone does not see it, because it only reads the payments the seller lists | `examples/scan-broken/01-hidden-bid`, `examples/testnet-broken/01-hidden-losing-bid` |
| Seller | Leave a refund or another payment out of the files | `scan-unlisted-payments` (with `--scan`) | `test/scan/scan.test.ts`, "an unlisted refund is reported on its own" |
| Seller | Write a false block number so a late bid looks on time | `scan-heights` (with `--scan`). Without `--scan` the seller's block numbers are taken as given | `examples/scan-broken/03-wrong-height` |
| Seller | List a refund that was paid after the refund deadline | `scan-listed-in-range` (with `--scan`) | `examples/scan-broken/02-listed-not-in-range` |
| Seller | List a transaction id that does not match the transaction bytes | `txids-match-bytes` | Code in `src/check.ts`. No broken example or test targets this check on its own |
| Seller | Pay a refund to their own wallet when the bidder wrote a refund address in the bid memo | `refund-receivers` | `examples/memo-broken/07-refund-to-other-address` |
| Seller | Publish a refund address list that disagrees with a bidder's own memo | `refund-receivers` (the bid memo wins) | `examples/memo-broken/08-list-contradicts-bid-memo` |
| Seller | Pay a refund to their own wallet when no address is in the memo or the list | Not caught, stated limit. The lot key shows the amount and the memo naming the bid, not who received it, unless that bidder adds their own key (`scan-refund-receivers`) | `test/scan/scan.test.ts`, "bidders' own keys prove their refunds arrived" |
| Seller | List their own address as a bidder's refund address, when the bid memo has none | Not caught, stated limit. That list is the seller's word, so each bidder has to check the address next to their bid | SPEC.md, "Who received each refund" |
| Seller | Keep part of the bid money, so refunds plus winners' payments fall short of what came in | `refund-total` | `examples/testnet-broken/02-short-refund-claim` |
| Seller | Publish headline totals that do not match the chain | `published-totals`, `published-totals-chain` | `examples/totals-broken/` (4 copies) |
| Seller | In a sealed lot, count a seal that was never opened, or opened with the wrong price | `seal-openings` | `examples/sealed-broken/01-counts-unopened-seal`, `02-counts-wrong-opening` |
| Seller | In a sealed lot, hide a seal that paid the penalty | `seal-forfeits` | `examples/sealed-broken/03-hides-unopened-seal` |
| Seller | In a sealed lot, keep the penalty instead of sharing it out | `refunds-paid`, `refund-total` | `examples/sealed-broken/04-keeps-the-penalty` |
| Seller | In a sealed lot, count a seal with the wrong deposit or one that came late | `seal-deposits` (and `no-late-bids` for the late one) | `examples/sealed-broken/05-counts-wrong-deposit`, `06-counts-late-seal` |
| Seller | Place a bid with their own money from a second wallet (a shill bid) | Not caught, stated limit. Imani sees that a payment was made, not who made it | None |
| Seller | In a plain lot, read bids as they arrive | Not caught, stated limit. Sealed lots close this, since the seller only sees same-size deposits and a code until the close | `examples/sealed-01` |
| Seller | In a sealed lot, plant extra seals and open only the one that suits them | Not caught, stated limit. Each seal left closed pays the penalty to the real bidders, and the report prints how many stayed closed | `seal-forfeits` message |
| Seller | Never publish the lot key | Not caught, stated limit. Only the basic checks on the seller's own files can run | `--basic` |
| Bidder | Pay after the close and hope it still counts | The bid is left out when Imani works out the winners and owed back in full. A seller who counts it fails `no-late-bids`, and one who does not refund it fails `refunds-paid` | `examples/broken/06-late-bid-counted` |
| Bidder | Send the same bid memo twice to be counted twice | `no-duplicate-bids`. The repeat is not a new bid and is owed back in full | `examples/guards/replayed-bid`, `test/check.test.ts` |
| Bidder | Put two bids in one transaction | `no-duplicate-bids` | Code in `src/check.ts` ("holds 2 bids") |
| Bidder | Top up a bid after the close in a lot that allows top-ups | The late payment stands alone as a late bid and is owed back in full | `test/pricing.test.ts`, "a payment after the close stands alone as a late bid" |
| Bidder | In a sealed lot, open with a price that does not match the seal | The seal is not counted and pays the penalty. A seller who counts it anyway fails `seal-openings` | `examples/sealed-broken/02-counts-wrong-opening` |
| Bidder | Claim their refund never arrived when it did | `refund-receivers` shows where the refund went, and the bidder's own key in `scan-refund-receivers` shows it arrived | `examples/memo-01`, `test/scan/scan.test.ts` |
| Bidder | Show someone else's bid proof as their own | Not caught, stated limit. A bid proof proves a payment was made, not who made it, like a receipt | `docs/BID_PROOF.md` |
| Bidder (or anyone) | Send a stray payment with a memo that is not a bid to the lot address, so an honest round shows a FAIL | Not caught, stated limit. Imani reports it under `key-hygiene` (or `scan-unlisted-payments` if the seller leaves it out) and cannot tell it apart from a seller who reused a key | `examples/guards/outside-payment` |
| Block server | Leave a bid out of a block | With `--fetch`, two servers run by different people must return the same list of transactions for each block, or the run stops with no verdict | `test/fetch/fetch.test.ts`, "servers that disagree about a block's contents make the fetch fail" |
| Block server | Change a transaction's bytes | Every transaction id is worked out again from the bytes. A changed transaction fails `scan-blocks-read`, or with `--fetch` the download refuses it | `test/scan/scan.test.ts`, "a block whose bytes are another transaction fails the scan"; `test/fetch/fetch.test.ts`, "wrong or padded bytes are rejected" |
| Block server | Change parts the transaction id does not cover (signatures and proofs) | With `--fetch`, a second server must return the very same bytes, or the run stops | `test/fetch/fetch.test.ts`, "servers that return different bytes for the same txid make the fetch fail" |
| Block server | Hold back a whole block | `scan-blocks-read`. A missing block is never filled in | `test/scan/scan.test.ts`, "a missing block fails the scan as incomplete" |
| Block server | Give a false block number for a transaction | With `--fetch`, the servers must agree on the block, or the run stops. A seller's false number then fails `scan-heights` | `test/scan/scan.test.ts`, "--fetch mode: a height the seller states wrongly is caught" |
| Block server | Serve the other network's blocks | The server is skipped | `test/fetch/fetch.test.ts`, "a server on the wrong network is skipped" |
| Block server | Two servers work together and both leave out the same bid | Not caught, stated limit. Run your own light server or Zebra node with `--server` | SPEC.md, "Known limits" |
| Block server | Hand you a doctored saved chain file | Not caught when the file is internally consistent, stated limit. A chain file is only as trustworthy as where you got it | SPEC.md, "Block heights against the chain" |
| Block server | Learn which blocks you checked, and your IP address | Not caught, stated limit. No key is ever sent, but the server sees the block numbers you ask for. Use your own node or `--proxy` | `test/fetch/fetch.test.ts`, "requests carry only txids and heights, never a key" |
| Lot-key holder | Move the lot's money | Cannot happen. A viewing key can only read, and Imani refuses spending keys and seed phrases | `test/leak.test.ts`, "spending keys and seed phrases in the lot key slot are refused" |
| Lot-key holder | Read every bid amount, bid memo and refund of the lot | Not caught, stated limit. This is what publishing the key is for, and it is how anyone can check the round | `docs/WHO_LEARNS_WHAT.md` |
| Lot-key holder | See which refund went to which bid, and so link a bidder's bid to the refund address they wrote in their memo | Not caught, stated limit. Each refund names its bid on purpose, so whoever holds the lot key can tie each bid to its refund address. `--discreet` only hides amounts, memos and addresses in what Imani prints and writes, not from the key holder | `node bin/imani.js linking examples/testnet-01/disclosure.json` |
| Lot-key holder | Follow one bidder across rounds when they reuse a refund address | Reported, not prevented: `imani linking` counts every link that reaches outside a round. Use a fresh address per auction | `test/privacy/linking.test.ts`, "memo-01 and receivers-01 together" |
| Lot-key holder | See the seller's other payments, if the seller reused the key | `key-hygiene` names them and asks for a fresh key per lot | `examples/guards/outside-payment`, `examples/guards/other-lot-bid` |
| Lot-key holder | Pull the key out of a shared report | The key is never printed or saved, and any output shaped like a key or seed phrase is blocked | `test/leak.test.ts`, "the lot key never shows up in stdout, stderr or any file" |
| Lot-key holder | Keep reading the lot forever | Not caught, stated limit. A shared viewing key cannot be taken back, which is why each lot uses its own fresh key | SPEC.md, "Known limits" |

## What Imani does not prove

1. Who a bidder is, or that a payment came from the person who says they made it. A shill bid from the seller's second wallet looks like any other bid.
2. That the seller never looked at bids before the close in a plain lot, or that a refund reached the bidder when no refund address is in the memo or the list and the bidder gives no key.
3. Anything outside the blocks it reads: bids before `openHeight`, blocks that two colluding servers both hide, or a saved chain file you got from someone you should not trust.

Every check and every known limit in full: [SPEC.md](../SPEC.md). Who can learn what: [WHO_LEARNS_WHAT.md](WHO_LEARNS_WHAT.md).
