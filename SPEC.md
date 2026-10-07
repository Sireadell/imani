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
| `openHeight` | First block height at which a bid counts. Needed only for the scan level |
| `refundByHeight` | Last block height by which every refund is paid. Needed only for the scan level |
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

## Scan level

The key level only reads the transactions the seller chose to list, and takes their block heights on the seller's word. The scan level reads every block of the lot's range with the lot key, so a bid the seller left out still shows up.

```sh
imani check --disclosure d.json --result r.json --scan --chain chain.json          # offline, the default way
imani check --disclosure d.json --result r.json --scan --fetch                     # online, opt-in
```

**Range.** From `openHeight` to `refundByHeight`, and always at least `--grace` blocks past `closeHeight` (default 10 blocks, about 12 minutes on mainnet). The grace window is there so a bid that just missed the close is found: it is late, must not be counted and must be refunded in full. Any bid found after the close is late, inside or after the grace window.

**Blocks.** With `--chain`, blocks come from a chain file on disk and no server is contacted. With `--fetch`, every block is downloaded by height through the fetch helper (see `docs/fetch/DESIGN.md`): two light servers run by different operators must agree on each block's transaction list, and two must return identical bytes for every transaction. No key is ever sent. The CLI prints `Servers contacted:` with the exact list, or `none`.

Chain file: `{ "format": "imani-chain/1", "network": "test", "blocks": [{ "height", "txs": [{ "txid", "txHex" }] }] }`. Blocks outside the range are ignored. A missing block is never invented: it fails the scan.

| Check id | Passes when |
|---|---|
| `scan-blocks-read` | Every block in the range was read, and every transaction id was recomputed from its bytes and matches |
| `scan-hidden-bids` | Every bid payment the lot key sees in the range is in the disclosure. Each one left out is named: `hidden bid: <txid> at block <h>, <amount>, memo <memo>` |
| `scan-unlisted-payments` | Every other payment the lot key sees in the range (refunds, payments that are not bids) is in the disclosure |
| `scan-listed-in-range` | Every listed transaction is in a block of the range. Otherwise: `listed payment not in the range` |
| `scan-heights` | Every listed transaction is in the block the seller states. Otherwise: `wrong height`, with a note when the true block is on the other side of the close |
| `scan-refund-receivers` | Only with `--bidder-keys`: for each bidder who gave their own viewing key, the refund the lot sent for their bid arrived in their wallet in full |

When the scan passes, the late/on-time split of the key level no longer rests on the seller's word, because every listed height was found on the chain.

### Who received each refund: what is and is not proven

| Question | Proven? | How |
|---|---|---|
| A refund left the lot, with the right amount and a memo naming the bid | Yes, lot key alone | Key level, `refunds-paid` |
| The refund went to the bidder who made that bid | Only for bidders who give their own viewing key | `scan-refund-receivers`: the bidder's key must see an incoming payment in the range with memo `refund:<lotId>:<bid txid>` and the same amount the lot sent |
| The same, for bidders who give no key | No | The lot key can in principle recover the receiver of an outgoing payment, but today's reader does not return it, and a bid memo carries no return address. A seller could pay a refund to their own second wallet with the right memo and this version would not notice |

Rule for a later version: a bid memo may end with the bidder's refund address (`bid:<lotId>:<word>:<address>`), the reader returns the receiver of each outgoing output, and the scan requires each refund to go to the address its bid named. Bidder key file: `{ "format": "imani-bidder-keys/1", "keys": [{ "bidTxid", "ufvk" }] }`. Bidder keys are checked like the lot key, never printed and never written.

### Speed and cost

Measured on this PC on 2026-10-07 against real mainnet blocks, with a public test key (ZIP 316 test vectors) that owns nothing, so nothing decrypted:

| Measure | 500 blocks (3,509,100 to 3,509,599) |
|---|---|
| Transactions in those blocks | 2,893 |
| Download time (12 blocks at a time) | 1,366 s, about 23 minutes (2.7 s per block) |
| Bytes of transactions received (both copies) | 28.4 MB (about 57 KB per block) |
| Time to read every transaction with the key | 27 s |
| Outputs the stranger key could read | 0 |
| Transactions the reader could not read | 0 |
| Servers contacted | zec.rocks, zec-node.cakewallet.com, lwd.zcashexplorer.app, us.zec.stardust.rest, zcash.mysideoftheweb.com, CipherScan API (the first two answered most requests; the others were used when those were busy) |

Earlier trials: 20 blocks fetched 4 at a time in each request group took 203 s (10 s per block); 20 blocks at once with no retry made the servers refuse. Run it yourself with `LIVE=1 node --disable-warning=ExperimentalWarning tools/measure-scan.ts 3509100 500 12`.

The slow part is the download. The fetch helper opens a new connection for every request and fetches every transaction twice (two operators), so a block costs about 20 to 25 requests. Blocks are fetched in parallel (`--concurrency`, default 12) with retries after a busy or dropped server; too many at once and the public servers start refusing. Reading every transaction with the key is fast (about 2 percent of the time). For a day-long auction (about 1,150 mainnet blocks) the measured rate gives about 52 minutes and about 65 MB with `--fetch`. Ways to make it fast, for a later step: compact-block scanning (the light wallet `GetBlockRange` stream gives only the encrypted outputs, about 1 to 2 KB per transaction instead of 5 to 10 KB, in one stream instead of thousands of connections; the full transaction is then fetched only for the few the key can read), reusing one connection per server, or a self-hosted light server.

## Privacy rules in the checker

The checker accepts only `uview1` or `uviewtest1` keys and refuses seed phrases, spending keys, incoming-only keys and keys for the wrong network. It never prints the key and never writes it to a file; reports show a 12-character fingerprint instead. By default it is offline: it reads only the files given and contacts no server, and says so. Only `--scan --fetch` goes online; it asks light servers for blocks by height, never sends a key, and prints every server contacted. `--discreet` hides amounts and memos everywhere. `report.html` contains no scripts and loads nothing.

## Known limits (this version)

| Limit | Why it matters | Later step |
|---|---|---|
| Without `--scan`, block heights come from the disclosure file | A seller could lie about when a bid was mined | Run the scan level: `scan-heights` checks every height against the chain |
| Without `--scan`, only disclosed transactions are read | A seller could hide a bid by not listing it | Run the scan level: `scan-hidden-bids` reads every block of the range |
| The scan only covers `openHeight` to the refund deadline | A bid paid before `openHeight` is not seen | The seller publishes `openHeight` before bidding starts |
| `--fetch` is slow: about an hour for a day-long auction | Checking a long auction online takes patience | Compact-block scanning, one connection per server |
| `--fetch` trusts that two independent light servers do not both leave the same transaction out of a block | Two colluding servers could hide a bid | Use your own light server with `--chain` saved from it, or more operators |
| A refund's receiver is proven only for bidders who give their own key | A seller could pay a refund to themselves with the right memo | Expose the receiver in the reader and put a refund address in the bid memo (see Scan level) |
| A shared viewing key cannot be revoked | Anyone with it sees the lot forever | One fresh key per lot, enforced by `key-hygiene` |
| The seller can see bids as they arrive | The check proves counting, amounts and refunds, not that the seller never looked | None in this design |
