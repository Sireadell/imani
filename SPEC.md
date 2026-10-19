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
| `openByHeight` | Sealed lots only: last block height at which a seal can be opened (see "Sealed lots") |
| `rules` | `{ "itemCount": 2, "reserveZat": 1000000 }` |
| `ufvk` | The lot's read-only viewing key, starting `uview1` (main) or `uviewtest1` (test). Optional: without it only the basic level runs |
| `transactions` | Every bid and refund transaction of the lot: `{ "txid", "height", "txHex" }` |
| `refundAddresses` | Optional. The address each bid's refund must go to: `[{ "bidTxid", "address" }]`, one per bid. A unified (`u1...`, `utest1...`) or Sapling address. When present, the key level adds the check `refund-receivers`. Not needed when the bidders wrote their address in their bid memo (see "Refund address in the bid memo"). Files without either check exactly as before |

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

Key level, reads each disclosed transaction with the lot key (refund addresses, when listed, are compared here too):

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
| `refund-receivers` | Only when the disclosure has `refundAddresses` or any bid memo carries an address. Every refund payment of the lot went to the address given for its bid (the bid memo wins over the seller's list, and a list that disagrees with a memo fails) (see "Who received each refund"). Fails when an address is missing for a refunded bid, listed twice, listed for a transaction that is not a bid, not a usable shielded address, for the wrong network, or different from where the refund went |
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

For every output it can open, the reader returns the 43-byte raw address the output was paid to (`recipientHex`). For a refund, which the lot sends, the lot key recovers this from the lot's outgoing viewing key. It also splits an address into its receivers (`parseAddress`), so a listed address can be compared with where a refund really went. Ironwood and Orchard outputs share the Orchard receiver of an address. A refund paid into a pool the listed address has no receiver for fails.

| Question | Proven? | How |
|---|---|---|
| A refund left the lot, with the right amount and a memo naming the bid | Yes, lot key alone | Key level, `refunds-paid` |
| The refund went to the address the disclosure lists for that bid | Yes, when the disclosure has `refundAddresses` | Key level, `refund-receivers`: the receiver the lot key recovers from the refund must equal the receiver in the listed address |
| The listed address is the bidder's own | No, not by the lot key. It is the seller's word | Each bidder looks up their bid in the list and confirms the address is theirs. Or the bidder gives their own viewing key |
| The refund reached the bidder who made the bid | Only for bidders who give their own viewing key | `scan-refund-receivers`: the bidder's key must see an incoming payment in the range with memo `refund:<lotId>:<bid txid>` and the same amount the lot sent |
| The same, for bidders who give no key and when no addresses are listed | No | A seller could pay a refund to their own second wallet with the right memo and this version would not notice |

What `refund-receivers` catches: a seller who publishes honest-looking addresses but pays a refund somewhere else. What it does not catch: a seller who lists their own address as the bidder's. A bid memo carries no return address today, so nothing on the chain ties a listed address to the bidder. This is now closed for bids that carry the address in the bid memo (`bid:<lotId>:<word>:<address>`, see "Refund address in the bid memo"): the lot key reads it from the chain and the seller cannot choose it. Bidder key file: `{ "format": "imani-bidder-keys/1", "keys": [{ "bidTxid", "ufvk" }] }`. Bidder keys are checked like the lot key, never printed and never written.

### Block heights against the chain

`scan-heights` compares the block each listed transaction was found in with the height the seller states. With `--chain` the blocks come from the saved file. With `--fetch` each transaction's block comes from what two independent operators return (two light servers, or on the test network a light server and the CipherScan explorer, which only counts as the second of the two), and a block is refused when they disagree. A wrong height is a named FAIL, and the message says when the true block is on the other side of the close. Without `--scan` no height is checked and the seller's word is used. A chain file is only as trustworthy as where you got it.

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

## Sealed lots

A plain lot lets the seller read every bid as it arrives, because the seller holds the lot key. A sealed lot hides the prices until the close. Plain lots work exactly as described above and are not affected.

How it works, in plain words: every bidder pays the same fixed deposit, and the memo holds only a hash (a short code that proves the price later and shows nothing now). After the close each bidder sends a tiny second payment that opens the seal. The checker verifies every opened price against its seal, runs the same price rule on the opened prices, and checks the refunds.

| Rule | |
|---|---|
| Rules in the disclosure | `{ "kind": "sealed", "itemCount", "reserveZat", "depositZat", "forfeitZat" }`. The disclosure also needs `openByHeight`, greater than `closeHeight` and at most `refundByHeight` when that is given. `0 <= forfeitZat <= depositZat` and `reserveZat <= depositZat` |
| Seal | A payment of exactly `depositZat` to the lot address, in a block at most `closeHeight`, with memo `seal:<lotId>:<word>:<hash>` or `seal:<lotId>:<word>:<hash>:<refund address>`. `<hash>` is 64 lowercase hex characters. A word is 1 to 32 letters or digits |
| Hash | `sha256("imani-seal/1|" + lotId + "|" + word + "|" + amountZat + "|" + salt + "|" + refundAddressOrEmpty)`, UTF-8, hex. `amountZat` is a plain decimal integer with no leading zeros. `salt` is 32 lowercase hex characters (16 random bytes) |
| Opening | A payment of any amount above 0 to the lot address, in a block after `closeHeight` and at most `openByHeight`, with memo `open:<lotId>:<word>:<amountZat>:<salt>` |
| A seal counts as a bid of `amountZat` when | its deposit is exactly `depositZat`, it is on time, exactly one opening for its word arrives in the window (the first opening for a word wins; later ones are replays), the hash matches, and `1 <= amountZat <= depositZat` |
| Price rule | The same uniform price rule as above, on the counted bids, with the opened price as the bid |
| Refund of a counted winner | `depositZat - clearingPrice + opening payment + share` |
| Refund of a counted loser | `depositZat + opening payment + share` |
| Refund of an unopened seal, or one with a wrong hash or a price out of range | `depositZat - forfeitZat`, plus the opening payment when a wrong opening arrived in the window |
| Wrong deposit, late seal, repeated word, malformed memo | Everything the payment carried, no share, no penalty |
| Opening that is replayed, outside the window, malformed, or for a word with no valid seal | Refunded in full as its own payment, with memo `refund:<lotId>:<opening txid>` |
| `share` | The total of all penalties split equally across counted bids, rounded down. The leftover zatoshis go to the counted bid with the lowest seal txid. With no counted bids no penalty is charged at all |
| Refund memo | `refund:<lotId>:<seal txid>`, one payment per seal |

Money check: refunds plus clearing price times winners equal everything paid in (deposits plus openings). The fee allowance stays 0.

The result file adds `unopened`: the txids of seals that paid the penalty (never opened, or opened wrongly). Refund `reason` may also be `unopened`, `bad-opening` or `opening`; `late` is also used for wrong-deposit, late and repeated seals.

New key-level checks, only for sealed lots:

| Check id | Passes when |
|---|---|
| `seal-deposits` | The seller counted no seal that paid the wrong deposit, arrived late, repeated a word or has a malformed memo. Those seals are refunded in full |
| `seal-openings` | The seller counted no seal that was never opened or was opened with a price that does not match its seal. Each counted bid has exactly one on-time matching opening |
| `seal-forfeits` | The seals the seller reports as unopened (`unopened`) are exactly the unopened or wrongly opened seals the chain shows. The message always prints how many seals were never opened |

`bid-count` compares the seller's list with the counted bids only, leaving seals that the three checks above judge. `key-hygiene`, `bid-amounts` (against the opened price), `no-late-bids`, `no-duplicate-bids` (a repeated seal word or opening word), `winners-and-price`, `reserve`, `refunds-paid`, `refund-receivers` (the address comes from the seal memo) and `refund-total` run as for plain lots. The scan level counts seals and openings as bid facts: a seal or opening left out of the disclosure fails `scan-hidden-bids`.

Bidders make the two memos with `imani seal --lot <id> --amount <zat> [--address <addr>]` and `imani open --file seal-<word>.json`. Neither command uses a network or a key. Examples: `examples/sealed-01` passes, `examples/sealed-broken/` has copies that each fail named checks; `npm run examples:sealed` rebuilds them.

## Privacy rules in the checker

The checker accepts only `uview1` or `uviewtest1` keys and refuses seed phrases, spending keys, incoming-only keys and keys for the wrong network. It never prints the key and never writes it to a file; reports show a 12-character fingerprint instead. By default it is offline: it reads only the files given and contacts no server, and says so. Only `--scan --fetch` goes online; it asks light servers for blocks by height, never sends a key, and prints every server contacted. `--discreet` hides amounts, memos and addresses everywhere. Before anything is printed or written, the text is checked and blocked if it holds something shaped like a viewing key, spending key or seed phrase. `--offline` refuses `--fetch`. `report.html` contains no scripts and loads nothing.

## Known limits (this version)

| Limit | Why it matters | Later step |
|---|---|---|
| Without `--scan`, block heights come from the disclosure file | A seller could lie about when a bid was mined | Run the scan level: `scan-heights` checks every height against the chain |
| Without `--scan`, only disclosed transactions are read | A seller could hide a bid by not listing it | Run the scan level: `scan-hidden-bids` reads every block of the range |
| The scan only covers `openHeight` to the refund deadline | A bid paid before `openHeight` is not seen | The seller publishes `openHeight` before bidding starts |
| `--fetch` is slow: about an hour for a day-long auction | Checking a long auction online takes patience | Compact-block scanning, one connection per server |
| `--fetch` trusts that two independent operators (light servers, or a light server and an explorer) do not both leave the same transaction out of a block | Two colluding servers could hide a bid | Use your own light server with `--chain` saved from it, or more operators |
| A listed refund address is the seller's word | A seller could list their own address as a bidder's, then pay it. `refund-receivers` would pass | Each bidder confirms the address next to their bid, or gives their own key. Later: put the refund address inside the bid memo |
| A refund's receiver is proven only when addresses are listed or the bidder gives their own key | Without either, a seller could pay a refund to themselves with the right memo | List `refundAddresses` in the disclosure |
| A shared viewing key cannot be revoked | Anyone with it sees the lot forever | One fresh key per lot, enforced by `key-hygiene` |
| The seller can see bids as they arrive | Only in plain lots. Sealed lots hide prices until the close. In a plain lot the check proves counting, amounts and refunds, not that the seller never looked | Use a sealed lot |
| In a sealed lot the seller sees how many deposits arrived and when | Hiding the number of bidders from the seller is out of scope | None in this design |
| A seller can plant several seals before the close and open only the one that suits them | Each seal left closed costs the penalty, paid to the real bidders who opened, and the check prints how many seals stayed closed. A seller willing to pay the penalty on planted seals is not stopped | Set `forfeitZat` high enough to make planting expensive |
| In a sealed lot the seller sees prices as they are opened, after the close | The seller cannot add a new seal any more (late seals are not counted) | None in this design |

## Refund address in the bid memo

A bid memo is `bid:<lotId>:<word>` or `bid:<lotId>:<word>:<refund address>`. The address is the last part after the final `:` and is a unified (`u1...`, `utest1...`) or Sapling address, which never contains a `:`. The bidder writes it inside their own payment, so the lot key reads it from the chain and the seller cannot change it. `refund-receivers` then compares it with the receiver the lot key recovers from each refund. If a bid memo has an address, that address is used even when the seller lists a different one (and the list then fails). If some bids carry an address and others do not, the ones without need an entry in `refundAddresses`. A repeated memo is still a replay, so the address cannot be used to place the same bid twice. Use a fresh address per auction, because after the close the lot key shows every address. Examples: `examples/memo-01` passes, `examples/memo-broken/` has two copies that fail `refund-receivers`; `npm run examples:memo` rebuilds them.
