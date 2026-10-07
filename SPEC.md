# imani lot check: file formats and rules (version 1)

This is how a seller publishes a sealed-bid auction so anyone can check it, and what the checker does with it. Amounts are in zatoshis (1 ZEC = 100,000,000 zatoshis).

## How a lot works

1. The seller makes a fresh wallet key for this one lot and publishes the lot address, the item count, the reserve (lowest accepted price) and the close height (the last block at which a bid counts).
2. A bid is a shielded payment of the full bid amount to the lot address, with a memo that starts with `bid:<lotId>:` followed by a short random word of the bidder's choice, for example `bid:LOT-01:q7k2`. Each bid memo must be used once.
3. After the close, the seller pays refunds from the lot address. Every refund carries the memo `refund:<lotId>:<bid txid>`, so it names the bid it pays back.
4. The seller publishes two files: the disclosure file and the result file. The disclosure file includes the lot's read-only viewing key. That key can show the lot's payments but can never move money.

## Price rule (uniform price)

1. Rank the on-time bids from highest to lowest. Equal amounts: earlier block first, then lower txid.
2. Only bids at or above the reserve can win. The top bids win, one item each, up to the item count.
3. Every winner pays the same clearing price: the highest bid that did not win, but never less than the reserve. If every bid wins, the price is the reserve.
4. Winners get back their bid minus the clearing price (their "change"). Losers get back their whole bid. Bids after the close, and replayed bids, are not counted and are returned in full.
5. If no bid reaches the reserve, there are no winners, the clearing price is 0 and everything is returned.

Example (round-01): 2 items, reserve 1,000,000. Bids of 3,000,000, 2,000,000 and 1,500,000 arrive on time, 1,200,000 arrives late. The two highest win, the price is 1,500,000, Alice gets 1,500,000 back, Bob 500,000, Carol 1,500,000 and Dave 1,200,000.

## Disclosure file

| Field | Meaning |
|---|---|
| `format` | `"imani-lot-disclosure/1"` |
| `lotId` | Lot name, 1 to 40 letters, digits, dots, dashes or underscores |
| `network` | `"main"` or `"test"` |
| `closeHeight` | Last block height at which a bid counts |
| `rules` | `{ "itemCount": 2, "reserveZat": 1000000 }` |
| `ufvk` | The lot's read-only viewing key, starting `uview1` (main) or `uviewtest1` (test). Optional: without it only the basic level runs |
| `transactions` | Every bid and refund transaction of the lot: `{ "txid", "height", "txHex" }` |

## Result file

| Field | Meaning |
|---|---|
| `format` | `"imani-lot-result/1"` |
| `lotId`, `rules` | Same as the disclosure |
| `bidCount` | Number of bids the seller counted |
| `bids` | `[{ "txid", "amountZat" }]` for every counted bid |
| `winners` | Txids of the winning bids |
| `clearingPriceZat` | Price each winner pays |
| `reserveMet` | `true` if at least one bid reached the reserve |
| `refunds` | `[{ "bidTxid", "amountZat", "reason", "memo" }]`, reason is `loser`, `change` or `late`, memo is `refund:<lotId>:<bidTxid>` |

## Checks

Basic level, no key needed: close height valid, disclosed txids unique, result file consistent with itself (counts, winners in the bid list, every listed loser refunded in full, refund memos, rules match), winner count no more than items and bids, clearing price between the reserve and the highest listed bid.

Key level, reads each disclosed transaction with the lot key:

| Check id | Passes when |
|---|---|
| `txids-match-bytes` | Every listed txid equals the id computed from the bytes |
| `key-hygiene` | Every payment into the lot is a bid for this lot. Anything else fails, with advice to use a fresh one-time key per lot |
| `bid-count` | The seller's counted bids (leaving out late ones, judged next) are exactly the on-time bids the key sees |
| `bid-amounts` | Each listed amount equals the amount on the chain |
| `no-late-bids` | No bid paid after `closeHeight` is in the seller's list |
| `no-duplicate-bids` | No bid memo is used twice and no transaction holds two bids |
| `winners-and-price` | Winners and clearing price recomputed from the on-time bids match the seller |
| `reserve` | Reserve outcome recomputed from the chain matches the seller |
| `refunds-paid` | Every refund owed (worked out from the chain) was paid in the exact amount, with a memo naming its bid |
| `refund-total` | Refunds the seller lists, plus clearing price times winners, equal the total bid money received. The fee allowance is 0: the seller pays network fees from their own money, never from bidders' money |

Each check owns one kind of fault, so a single tampered fact fails a single check. `refunds-paid` judges what was really paid; `refund-total` judges whether the seller's own books add up.

## Privacy rules in the checker

The checker accepts only `uview1` or `uviewtest1` keys and refuses seed phrases, spending keys, incoming-only keys and keys for the wrong network. It never prints the key and never writes it to a file; reports show a 12-character fingerprint instead. This version is offline: it reads only the two files given and contacts no server, and says so. `--discreet` hides amounts and memos everywhere. `report.html` contains no scripts and loads nothing.

## Known limits (this version)

| Limit | Why it matters | Later step |
|---|---|---|
| Block heights come from the disclosure file | A seller could lie about when a bid was mined | Confirm heights with one named light server |
| Only disclosed transactions are read | A seller could hide a bid by not listing it | Scan the lot address over the auction window with the key |
| The refund's recipient address is not checked | A seller could pay a refund to themselves with the right memo | Expose the recipient in the reader; let a bidder confirm "my bid counted" and "my refund arrived" with their own key |
| A shared viewing key cannot be revoked | Anyone with it sees the lot forever | One fresh key per lot, enforced by `key-hygiene` |
| The seller can see bids as they arrive | The check proves counting, amounts and refunds, not that the seller never looked | None in this design |
