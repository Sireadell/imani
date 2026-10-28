# Lot file format, version 1

Two small JSON files let anyone check a sealed-bid auction or an all-or-nothing fundraiser paid in shielded Zcash. Any project can publish them, and any checker can read them. This page is the contract: what goes in each file, which check reads each field, and how to test a checker of your own against 52 ready-made rounds.

| File | Format string | Schema |
|---|---|---|
| Disclosure file | `"imani-lot-disclosure/1"` | [`schema/disclosure.schema.json`](../schema/disclosure.schema.json) |
| Result file | `"imani-lot-result/1"` | [`schema/result.schema.json`](../schema/result.schema.json) |
| Bid proof (optional, one bid, made later) | `"imani-bid-proof/1"` | [`schema/bid-proof.schema.json`](../schema/bid-proof.schema.json), described in [`BID_PROOF.md`](BID_PROOF.md) |

The rules a checker applies (price rule, refunds, sealed lots) are in [`SPEC.md`](../SPEC.md). Amounts are always whole numbers of zatoshis (1 ZEC = 100,000,000 zatoshis). A "txid" is a transaction id: 64 lowercase hex characters (digits and the letters a to f). A "block height" is the number of a block on the chain.

## 1. Who writes what, and when

| Who | What | When |
|---|---|---|
| Seller | Publishes the lot name, the lot address, the rules and the close height | Before bidding opens |
| Bidder | Pays the lot address with a memo (a short note inside the payment) that says what the payment is | During bidding (sealed lots: a seal before the close, then an opening after it) |
| Seller | Pays every refund from the lot address, each with a memo naming the bid it pays back | After the close, by the refund deadline |
| Seller | Writes and publishes the **disclosure file**: the rules, the block heights, every transaction of the round and the lot's viewing key (a read-only key that can show the lot's payments but never move money) | After the last refund |
| Seller | Writes and publishes the **result file**: what the seller says happened (bids counted, winners, price, refunds) | Same time, next to the disclosure |
| Anyone | Runs a checker on the two files. The checker recomputes every number from the chain and says PASS or FAIL, naming each failed check | Any time after |

The result file is the seller's claim. The disclosure file is the evidence. A checker never trusts the result file: it reads the transactions with the viewing key and compares.

## 2. The fields

**Levels.** Checks run in three levels. The **basic level** needs only the two files. The **key level** runs when the disclosure has a viewing key and reads every listed transaction with it. The **scan level** runs only when asked (`--scan`) and reads every block of the lot's range, so a payment the seller left out still shows up. Check ids below are the ones a checker must print (see section 5).

**Bad input.** Before any check runs, the files are validated. A file that breaks the rules marked "refused" below is not judged at all: the checker reports bad input (exit code 2), not FAIL.

### Disclosure file (`imani-lot-disclosure/1`)

| Field | Type | Required | Lot kind | Read by |
|---|---|---|---|---|
| `format` | text, exactly `"imani-lot-disclosure/1"` | Yes | All | Refused if wrong |
| `lotId` | text, 1 to 40 letters, digits, dots, dashes or underscores | Yes | All | Every memo starts with it, so every key-level check (`key-hygiene` first). `result-consistent` (must equal the result file's `lotId`) |
| `network` | `"main"` or `"test"` | Yes | All | Refused if the key is for the other network. `refund-receivers` (addresses must be for this network) |
| `closeHeight` | whole number, 1 or more | Schema: optional. In practice yes: without it `close-height` fails | All | `close-height`, `no-late-bids`, `bid-count`, `winners-and-price`, `refunds-paid`, `seal-deposits`, `seal-openings`, scan range |
| `openHeight` | whole number, 1 or more | Only for the scan level | All | Start of the scan range (all `scan-*` checks). The scan is refused without it |
| `refundByHeight` | whole number, 1 or more | Only for the scan level | All | End of the scan range. Sealed lots: `openByHeight` may not be after it (refused) |
| `openByHeight` | whole number, above `closeHeight` | Yes for sealed lots (refused without it) | Sealed | `seal-openings` (last block an opening counts), `refunds-paid` |
| `rules` | object, one of three shapes (below) | Yes | All | `result-consistent`, `winner-count`, `clearing-range`, `goal-reached`, `winners-and-price`, `reserve`, `refunds-paid`, `seal-deposits`, `seal-openings`, `seal-forfeits` |
| `ufvk` | text starting `uview1` (main) or `uviewtest1` (test) | Optional. Without it only the basic level runs | All | Turns on the key level and the scan level. Never printed: reports show a 12-character fingerprint |
| `transactions` | list of `{ txid, height, txHex }` | Yes (the list can be empty) | All | See the next three rows |
| `transactions[].txid` | 64 hex characters | Schema: optional. In practice yes: `disclosure-txids-unique` fails without it | All | `disclosure-txids-unique`, `txids-match-bytes`, `scan-hidden-bids`, `scan-unlisted-payments`, `scan-heights` |
| `transactions[].height` | whole number, 1 or more | Schema: optional. In practice yes: `close-height` fails without it | All | `close-height`, the on-time or late split in `bid-count`, `no-late-bids` and `refunds-paid`, `scan-heights`, `scan-listed-in-range` |
| `transactions[].txHex` | the raw transaction as hex text | Yes (refused without it) | All | Every key-level check reads it with the key. `txids-match-bytes` recomputes the id from it |
| `refundAddresses` | list of `{ bidTxid, address }`, one per bid | Optional | All | `refund-receivers`, which runs only when this list is present or a bid memo carries an address |

**`rules`, the three shapes.**

| Field | Type | Auction | Goal | Sealed |
|---|---|---|---|---|
| `kind` | `"auction"`, `"goal"` or `"sealed"` | Optional, `"auction"` when left out | Required | Required |
| `itemCount` | whole number, 1 or more | Required | Not used | Required |
| `reserveZat` | whole number, 0 or more | Required | Not used | Required, at most `depositZat` |
| `pricing` | `"highest-losing"` (the default) or `"lowest-winning"` | Optional | Not used | Not used (always the default) |
| `topUps` | `true` or `false` | Optional, off when left out | Not used | Not used |
| `goalZat` | whole number, 1 or more | Not used | Required | Not used |
| `depositZat` | whole number, 1 or more | Not used | Not used | Required |
| `forfeitZat` | whole number, 0 up to `depositZat` | Not used | Not used | Required |

### Result file (`imani-lot-result/1`)

| Field | Type | Required | Lot kind | Read by |
|---|---|---|---|---|
| `format` | text, exactly `"imani-lot-result/1"` | Yes | All | Refused if wrong |
| `lotId` | same as the disclosure | Schema: optional. In practice yes: `result-consistent` fails unless it equals the disclosure's | All | `result-consistent`, and every refund memo is compared with it |
| `rules` | same object as the disclosure | Schema: optional. In practice yes: `result-consistent` fails unless every rule field matches | All | `result-consistent` |
| `bidCount` | whole number | Schema: optional. In practice yes: must equal the length of `bids` | All | `result-consistent` |
| `bids` | list of `{ txid, amountZat }` | Yes | All. Goal lots: every on-time payment. Sealed lots: the opened price, not the deposit | `result-consistent`, `winner-count`, `clearing-range`, `goal-reached`, `bid-count`, `bid-amounts`, `no-late-bids`, `seal-deposits`, `seal-openings`, `published-totals` |
| `winners` | list of txids, each also in `bids` | Yes (can be empty) | All. Goal lots: the counted payments, all of `bids` or none | `result-consistent`, `winner-count`, `clearing-range`, `winners-and-price`, `refund-total`, `published-totals` |
| `clearingPriceZat` | whole number, 0 or more | Schema: optional. In practice yes | Auction and sealed. Goal lots: always 0 | `result-consistent`, `clearing-range`, `winners-and-price`, `refund-total`, `published-totals` |
| `reserveMet` | `true` or `false` | Schema: optional. In practice yes: must be `true` exactly when `winners` is not empty | All. Goal lots: "the goal was reached" | `result-consistent`, `goal-reached`, `reserve` |
| `refunds` | list of `{ bidTxid, amountZat, reason, memo }` | Yes (can be empty) | All | `result-consistent`, `refund-total`, `published-totals`. (`refunds-paid` does not read this list. It reads the refunds on the chain.) |
| `refunds[].reason` | `loser`, `change`, `late`; sealed lots also `unopened`, `bad-opening`, `opening` | Yes | All | `result-consistent` (a `change` refund must be for a winner) |
| `refunds[].memo` | exactly `refund:<lotId>:<bidTxid>` | Yes | All | `result-consistent` |
| `unopened` | list of txids | Sealed lots | Sealed | `seal-forfeits`: must be exactly the seals that paid the penalty |
| `totals` | `{ payments, receivedZat, keptZat, refundedZat }`, whole numbers | Optional | All | `published-totals` (they add up), `published-totals-chain` (they match the chain) |

**Checks that read no field directly.** The scan checks `scan-blocks-read`, `scan-hidden-bids`, `scan-unlisted-payments`, `scan-listed-in-range` and `scan-heights` read a third file, the chain file (`{ "format": "imani-chain/1", "network", "blocks": [{ "height", "txs": [{ "txid", "txHex" }] }] }`), and compare it with `transactions`. `scan-refund-receivers` runs only when bidders hand over their own viewing keys. Both are described in `SPEC.md`, "Scan level".

### Field sizes

How big each field can be. These are the limits the schemas and the checker enforce today. Where a row says "no upper limit", the files set none, so only the checker's own memory and time bound the size.

| Field | Size limit |
|---|---|
| `lotId` | 1 to 40 characters: letters, digits, dots, dashes or underscores |
| Any txid (`txid`, `bidTxid`, entries in `winners` and `unopened`) | Exactly 64 lowercase hex characters |
| Block heights (`closeHeight`, `openHeight`, `refundByHeight`, `openByHeight`, `height`) | Whole number, 1 or more, no upper limit |
| Amounts in zatoshis (`reserveZat`, `forfeitZat`, `amountZat`, the `totals` fields and the result file's `bidCount`) | Whole number, 0 or more, no upper limit in the schema. `goalZat` and `depositZat` need 1 or more |
| Amount written inside an opening memo | At most 16 digits, no leading zero |
| `itemCount` | Whole number, 1 or more, no upper limit |
| `ufvk` | Starts `uview1` or `uviewtest1`, then lowercase letters and digits, no upper limit |
| `transactions[].txHex` | Hex text of whole bytes (an even number of digits), no upper limit |
| `transactions` | No upper limit on the list |
| `refundAddresses[].address` | Any text with a non-space character; read as an address for the lot's network |
| Memo (a payment note) | 1 to 512 bytes |
| Bid or seal word in a memo | 1 to 32 letters or digits |
| Seal hash in a seal memo | Exactly 64 lowercase hex characters |
| Salt in an opening memo | Exactly 32 hex characters (lowercase) |

## 3. The three kinds of lot

| Kind | What it is | Who wins | Who gets money back |
|---|---|---|---|
| Auction | Sealed-bid auction of `itemCount` identical items | The top bids at or above the reserve, one item each | Losers in full, winners their bid minus the price, late and repeated bids in full |
| Goal | All-or-nothing collection (a fundraiser, a group buy) | Nobody "wins": if the on-time payments reach `goalZat`, all of them are kept | Goal reached: only late payments. Goal missed: everyone in full |
| Sealed | Auction where nobody, the seller included, sees a price before the close | Same as an auction, on the opened prices | Deposit minus price for winners, deposit for losers, deposit minus penalty for seals not opened, each plus a share of the penalties |

**The two price rules (auction only).** With `"pricing": "highest-losing"` or no `pricing` at all, every winner pays the highest bid that did not win, never less than the reserve. With `"pricing": "lowest-winning"`, every winner pays the lowest bid that won, so the last bidder in pays exactly what they bid. The result file must repeat the same `pricing` or `result-consistent` fails. Real example: `examples/pricing-01`, whose rules are `{ "itemCount": 3, "reserveZat": 1000000, "pricing": "lowest-winning" }`.

**Top-ups (auction only).** With `"topUps": true`, a bidder may pay again before the close using the exact same bid memo to raise their bid. All on-time payments under one memo add up to one bid, named by its first payment. Without it, a second payment under a used memo is a replay, not counted and refunded in full. The result file must repeat `topUps`. No round in `examples/` uses top-ups. They are covered by `test/pricing.test.ts`.

The three examples below are copied from the real files. Two things are shortened so they fit on the page: each `txHex` (about 18,600 hex characters in the real file) and the viewing key. Everything else is exactly as published. Each file passes every check.

### Auction: `examples/round-01`

Two items, reserve 1,000,000. Three bids on time (3,000,000, 2,000,000, 1,500,000), one late (1,200,000, at block 4200105, after the close at 4200100). The last four transactions are the refunds.

```json
{
  "format": "imani-lot-disclosure/1",
  "lotId": "LOT-01",
  "network": "test",
  "closeHeight": 4200100,
  "rules": {
    "itemCount": 2,
    "reserveZat": 1000000
  },
  "ufvk": "uviewtest17w56...",
  "transactions": [
    { "txid": "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8", "height": 4200010, "txHex": "0600008098b6..." },
    { "txid": "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002", "height": 4200020, "txHex": "0600008098b6..." },
    { "txid": "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c", "height": 4200030, "txHex": "0600008098b6..." },
    { "txid": "ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb", "height": 4200105, "txHex": "0600008098b6..." },
    { "txid": "8f92b093ce06ac398cafaddd5c053c06bfe6d2dbffa548dbe8712d1ddbbc8744", "height": 4200120, "txHex": "0600008098b6..." },
    { "txid": "e519a860f0160de8a5738ae9811ff008b88c78b055c560cdca4bab1e8237c0f8", "height": 4200121, "txHex": "0600008098b6..." },
    { "txid": "12260d9742b3b633b3d23714412d0815d96a17a59306d8c4c85197b2f60b0a6d", "height": 4200122, "txHex": "0600008098b6..." },
    { "txid": "56d790d794cd1fad135791529573af0e087ffaba2a0f3f12b32dfc13911798d1", "height": 4200123, "txHex": "0600008098b6..." }
  ]
}
```

```json
{
  "format": "imani-lot-result/1",
  "lotId": "LOT-01",
  "rules": { "itemCount": 2, "reserveZat": 1000000 },
  "bidCount": 3,
  "bids": [
    { "txid": "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8", "amountZat": 3000000 },
    { "txid": "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002", "amountZat": 2000000 },
    { "txid": "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c", "amountZat": 1500000 }
  ],
  "winners": [
    "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8",
    "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002"
  ],
  "clearingPriceZat": 1500000,
  "reserveMet": true,
  "refunds": [
    { "bidTxid": "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8", "amountZat": 1500000, "reason": "change", "memo": "refund:LOT-01:d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8" },
    { "bidTxid": "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002", "amountZat": 500000, "reason": "change", "memo": "refund:LOT-01:43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002" },
    { "bidTxid": "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c", "amountZat": 1500000, "reason": "loser", "memo": "refund:LOT-01:e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c" },
    { "bidTxid": "ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb", "amountZat": 1200000, "reason": "late", "memo": "refund:LOT-01:ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb" }
  ]
}
```

Note that the late bid is not in `bids`, but its refund is listed with reason `late`.

### Goal: `examples/goal-reached`

Goal 6,000,000. Three on-time payments add up to 6,500,000, so all three are kept and none is refunded. The late payment is refunded in full.

```json
{
  "format": "imani-lot-disclosure/1",
  "lotId": "LOT-01",
  "network": "test",
  "closeHeight": 4200100,
  "ufvk": "uviewtest17w56...",
  "rules": {
    "kind": "goal",
    "goalZat": 6000000
  },
  "transactions": [
    { "txid": "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8", "height": 4200010, "txHex": "0600008098b6..." },
    { "txid": "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002", "height": 4200020, "txHex": "0600008098b6..." },
    { "txid": "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c", "height": 4200030, "txHex": "0600008098b6..." },
    { "txid": "ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb", "height": 4200105, "txHex": "0600008098b6..." },
    { "txid": "56d790d794cd1fad135791529573af0e087ffaba2a0f3f12b32dfc13911798d1", "height": 4200123, "txHex": "0600008098b6..." }
  ]
}
```

```json
{
  "format": "imani-lot-result/1",
  "lotId": "LOT-01",
  "rules": { "kind": "goal", "goalZat": 6000000 },
  "bidCount": 3,
  "bids": [
    { "txid": "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8", "amountZat": 3000000 },
    { "txid": "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002", "amountZat": 2000000 },
    { "txid": "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c", "amountZat": 1500000 }
  ],
  "winners": [
    "d928588fc1669a6586057c852f7e2965cf49a081ef415324338953161d446ef8",
    "43e9e39e43aea9b01be1ca994eab7fbc17705853f62b131e2aede9fba4cae002",
    "e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c"
  ],
  "clearingPriceZat": 0,
  "reserveMet": true,
  "refunds": [
    { "bidTxid": "ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb", "amountZat": 1200000, "reason": "late", "memo": "refund:LOT-01:ab867ef0972f6425bbc0f386d1e228683317134cfbb989542c592dd3e1668cdb" }
  ]
}
```

A goal lot reuses the auction fields with a goal meaning: `bids` are the on-time payments, `winners` are the payments kept (all or none), `reserveMet` means "goal reached" and `clearingPriceZat` is always 0. The missed version is `examples/goal-missed`.

### Sealed: `examples/sealed-01`

Two items, reserve 1,000,000, deposit 5,000,000, penalty 500,000. Six seals arrive before the close. Three open correctly (3,000,000, 2,000,000, 1,500,000), one is never opened, one is opened with a price that does not match its seal, one paid the wrong deposit. One more seal arrives late. The penalties of the two bad seals (1,000,000) are shared across the three counted bids, which is why the refunds are not round numbers.

```json
{
  "format": "imani-lot-disclosure/1",
  "lotId": "LOT-01",
  "network": "test",
  "closeHeight": 4200100,
  "openByHeight": 4200200,
  "rules": {
    "depositZat": 5000000,
    "forfeitZat": 500000,
    "itemCount": 2,
    "kind": "sealed",
    "reserveZat": 1000000
  },
  "ufvk": "uviewtest16l92...",
  "transactions": [
    { "txid": "a2b72e11b9706edea360488cb18650f6c974ea6eb49f1b6d58973f4f6cf49317", "height": 4200010, "txHex": "0600008098b6..." },
    { "txid": "e18831cd9f67f084a1f7edaaa5ec8b21f8fc62a4728046e0d5b6f442d307babb", "height": 4200020, "txHex": "0600008098b6..." },
    { "txid": "ef125c1c0ceed0ef1c5a07de39c0335d8f767b6414135cdf7112464368a85683", "height": 4200030, "txHex": "0600008098b6..." },
    ... 15 more, same shape: the other seals, the openings and the refunds
  ]
}
```

```json
{
  "format": "imani-lot-result/1",
  "lotId": "LOT-01",
  "rules": { "depositZat": 5000000, "forfeitZat": 500000, "itemCount": 2, "kind": "sealed", "reserveZat": 1000000 },
  "bidCount": 3,
  "bids": [
    { "txid": "a2b72e11b9706edea360488cb18650f6c974ea6eb49f1b6d58973f4f6cf49317", "amountZat": 3000000 },
    { "txid": "e18831cd9f67f084a1f7edaaa5ec8b21f8fc62a4728046e0d5b6f442d307babb", "amountZat": 2000000 },
    { "txid": "ef125c1c0ceed0ef1c5a07de39c0335d8f767b6414135cdf7112464368a85683", "amountZat": 1500000 }
  ],
  "winners": [
    "a2b72e11b9706edea360488cb18650f6c974ea6eb49f1b6d58973f4f6cf49317",
    "e18831cd9f67f084a1f7edaaa5ec8b21f8fc62a4728046e0d5b6f442d307babb"
  ],
  "clearingPriceZat": 1500000,
  "reserveMet": true,
  "refunds": [
    { "bidTxid": "a2b72e11b9706edea360488cb18650f6c974ea6eb49f1b6d58973f4f6cf49317", "amountZat": 3843334, "reason": "change", "memo": "refund:LOT-01:a2b72e11b9706edea360488cb18650f6c974ea6eb49f1b6d58973f4f6cf49317" },
    { "bidTxid": "e18831cd9f67f084a1f7edaaa5ec8b21f8fc62a4728046e0d5b6f442d307babb", "amountZat": 3843333, "reason": "change", "memo": "refund:LOT-01:e18831cd9f67f084a1f7edaaa5ec8b21f8fc62a4728046e0d5b6f442d307babb" },
    { "bidTxid": "ef125c1c0ceed0ef1c5a07de39c0335d8f767b6414135cdf7112464368a85683", "amountZat": 5343333, "reason": "loser", "memo": "refund:LOT-01:ef125c1c0ceed0ef1c5a07de39c0335d8f767b6414135cdf7112464368a85683" },
    { "bidTxid": "aaa5f1d6cb61ec26929fd803ef81d1163ac540bd5ede6a8370b471ec29441234", "amountZat": 4500000, "reason": "unopened", "memo": "refund:LOT-01:aaa5f1d6cb61ec26929fd803ef81d1163ac540bd5ede6a8370b471ec29441234" },
    { "bidTxid": "2d5baba9b76a2c7752a3bd2853f34e79217eab46ab7e78e2adeece99463f4994", "amountZat": 4510000, "reason": "bad-opening", "memo": "refund:LOT-01:2d5baba9b76a2c7752a3bd2853f34e79217eab46ab7e78e2adeece99463f4994" },
    { "bidTxid": "c3efaa754c5ac485725bb4c6b550002c8db1238f89d83b4792c94e976850ddc1", "amountZat": 4999999, "reason": "late", "memo": "refund:LOT-01:c3efaa754c5ac485725bb4c6b550002c8db1238f89d83b4792c94e976850ddc1" },
    { "bidTxid": "ba9bb57c220cd1c5851c7768e3682ab5c9afae07c9a42231c59c734a6e8e9f68", "amountZat": 5000000, "reason": "late", "memo": "refund:LOT-01:ba9bb57c220cd1c5851c7768e3682ab5c9afae07c9a42231c59c734a6e8e9f68" }
  ],
  "unopened": [
    "aaa5f1d6cb61ec26929fd803ef81d1163ac540bd5ede6a8370b471ec29441234",
    "2d5baba9b76a2c7752a3bd2853f34e79217eab46ab7e78e2adeece99463f4994"
  ]
}
```

In a sealed lot, `amountZat` in `bids` is the opened price, the bid txid is the seal's txid, and `reason: "late"` also covers seals with the wrong deposit, a repeated word or a broken memo.

## 4. Memos: the notes inside each payment

A shielded Zcash payment carries a memo of up to 512 bytes that only the people in the payment, or someone holding a viewing key, can read. The whole format rests on four memo shapes. `<lotId>` is the disclosure's `lotId`. A `<word>` is any short label the bidder picks (sealed lots: 1 to 32 letters or digits).

| Memo | Shape | Sent by | Lot kind |
|---|---|---|---|
| Bid | `bid:<lotId>:<word>` or `bid:<lotId>:<word>:<refund address>` | Bidder, to the lot | Auction, goal |
| Seal | `seal:<lotId>:<word>:<hash>` or `seal:<lotId>:<word>:<hash>:<refund address>` | Bidder, to the lot, paying exactly `depositZat`, by the close | Sealed |
| Open | `open:<lotId>:<word>:<amountZat>:<salt>` | Bidder, to the lot, any amount above 0, after the close and by `openByHeight` | Sealed |
| Refund | `refund:<lotId>:<bid txid>` | Seller, from the lot | All |

**How a checker reads them.**

| Rule | Detail |
|---|---|
| Sorting payments into the lot | A payment into the lot whose memo starts with `bid:<lotId>:` is a bid (auction, goal). In a sealed lot, one starting `seal:<lotId>:` or `open:<lotId>:` is a seal or an opening. Anything else coming in fails `key-hygiene`, because it means the key was used for more than one lot |
| Sorting payments out of the lot | A payment out of the lot whose memo starts with `refund:<lotId>:` is a refund. The rest of the memo is the txid of the payment it pays back. Several refunds for one txid are added up. Change the lot pays itself is ignored |
| A bid is the whole transaction | All parts of one transaction carrying a bid memo are added up into one bid, and a transaction holding more than one bid part fails `no-duplicate-bids` |
| A memo is used once | The same bid memo in a second transaction is a replay: not counted, refunded in full, and reported by `no-duplicate-bids`. With `"topUps": true` it raises the first bid instead, if it arrives by the close |
| Refund address in a memo | The address is the part after the last `:`. It is a unified address (`u1...` or `utest1...`) or a Sapling address, and never contains a `:`. Because the bidder wrote it inside their own payment, the seller cannot change it, and `refund-receivers` compares it with where each refund really went |
| The seal hash | `<hash>` is 64 lowercase hex characters: `sha256("imani-seal/1|" + lotId + "|" + word + "|" + amountZat + "|" + salt + "|" + refundAddressOrEmpty)`, written as hex. `amountZat` has no leading zeros and `salt` is 32 lowercase hex characters. A seal counts only when exactly one opening for its word arrives in the window, its hash matches, and the price is from 1 up to the deposit. Full rules: `SPEC.md`, "Sealed lots" |
| Refund memo in the result file | Each entry in `refunds` must carry `memo` exactly equal to `refund:<lotId>:<bidTxid>`, or `result-consistent` fails |

## 5. The conformance kit

The kit tests any checker, written in any language, against real rounds where the right answer is known.

**What `conformance/manifest.json` holds.** 66 cases. 14 are honest rounds that must PASS. 52 are broken copies of those rounds, each with one dishonest change by the seller, that must FAIL. Each broken case lists in `failing` every check id a correct checker must name, and has a one-line `story` of what the seller did. Seven cases (2 honest, 5 broken) also come with a chain file and must be checked with a full scan. All files live under `examples/`, and `npm run conformance:make` rebuilds the manifest from them.

| Group | Cases | Check ids the broken copies must name |
|---|---|---|
| Honest rounds | 10 (`round-01`, `memo-01`, `receivers-01`, `scan-01`, `goal-reached`, `goal-missed`, `pricing-01`, `totals-01`, `sealed-01`, `testnet-01`) | None, all must PASS |
| `broken/` | 6 | `bid-count`, `bid-amounts`, `refunds-paid`, `winners-and-price`, `no-late-bids` |
| `memo-broken/` | 8 | The same, plus `refund-receivers` |
| `receivers-broken/` | 2 | `refund-receivers` |
| `goal-broken/` | 4 | `refund-total`, `result-consistent`, `goal-reached`, `reserve`, `winners-and-price`, `refunds-paid` |
| `pricing-broken/` | 5 | `clearing-range`, `refund-total`, `winners-and-price`, `result-consistent`, `refunds-paid`, `bid-count` |
| `totals-broken/` | 4 | `published-totals`, `published-totals-chain`, `refund-total` |
| `sealed-broken/` | 8 | `seal-openings`, `seal-forfeits`, `seal-deposits`, `refunds-paid`, `refund-total`, `no-late-bids`, `bid-amounts` |
| `scan-broken/` (with a chain file) | 3 | `scan-hidden-bids`, `scan-listed-in-range`, `scan-heights` |
| `testnet-broken/` (with a chain file) | 2 | `refunds-paid`, `refund-total`, `scan-hidden-bids`, `scan-unlisted-payments`, `result-consistent` |

**How a checker is scored.** From the root of this repository:

```sh
npm run conformance -- --cmd "<checker command>"
```

| Step | What happens |
|---|---|
| 1 | For each of the 66 cases, the kit runs your command with `--disclosure <file> --result <file>` added. Cases with a chain file also get `--scan --chain <file>` |
| 2 | Your command's exit code is its verdict: 0 means PASS, 1 means FAIL. Any other exit code counts as a wrong answer. Printing "FAIL" while exiting 0 is a PASS |
| 3 | For a broken case, the verdict counts as fully right only if your command also printed (on normal output or error output) the id of every check in `failing`, each as a whole word. `refunds-paid` is not found inside `refunds-paid-late` |
| 4 | The kit prints each case it got wrong, then three score lines. It exits 0 only for a full score (every verdict right and every broken copy named), and 1 otherwise |

**Real runs, 2026-10-26.** Imani's own checker:

```text
$ npm run conformance -- --cmd "node bin/imani.js check"
Right verdict: 66 of 66 (honest rounds passed: 14 of 14; broken copies failed: 52 of 52)
Broken copies failed on the right check: 52 of 52
Conformance: FULL (66 of 66 verdicts right, 52 of 52 broken copies named correctly)
```

It took 39 seconds on a laptop. A script that does nothing but exit 0 (`process.exit(0);`), so it says PASS to everything:

```text
$ npm run conformance -- --cmd "node always-pass.mjs"
  broken/01-extra-fake-bid: expected FAIL, got PASS
  ... the same line for each of the other 41 broken copies ...
Right verdict: 14 of 66 (honest rounds passed: 14 of 14; broken copies failed: 0 of 52)
Broken copies failed on the right check: 0 of 52
Conformance: PARTIAL (14 of 66 verdicts right, 0 of 52 broken copies named correctly)
```

A checker that says FAIL to everything scores 52 of 66 verdicts and names 0 of 52, so neither shortcut can reach a full score. Both are run by `test/format.test.ts` on every test run.

## 6. Versions, and how to ask for a new field

The format string (`imani-lot-disclosure/1`, `imani-lot-result/1`) changes only when a change would break an existing checker or an existing file.

| Change | Format string | Example from version 1 |
|---|---|---|
| A new optional field. Files without it mean exactly what they meant before. A checker that does not know the field still judges everything it already checked correctly: it either fails the round or simply does not check the new claim | Stays `/1` | `pricing` and `topUps` (an older checker works out a different price, or sees a repeated memo, and says FAIL). `refundAddresses` and `totals` (an older checker skips the extra claim). A file using none of them checks exactly as before |
| An existing field changes meaning, an optional field becomes required, a field is removed or renamed, or a new field would make an older checker get the winners, the price or the refunds wrong | Goes to `/2` | None so far |

An older checker never checks a newer optional claim, so use a checker that scores full marks on the current kit. When the string goes to `/2`, version 1 files keep their meaning, and a checker should refuse a format string it does not know rather than guess (Imani's checker does).

**To ask for a new field**, open an issue at [github.com/Sireadell/imani](https://github.com/Sireadell/imani/issues) with:

| Include | Why |
|---|---|
| The field name, its type and which lot kind uses it | So it can go into the schema and the tables above |
| What a checker should do with it, and which check id fails when it is wrong | Every check owns one kind of fault, so a new fact needs a clear owner |
| What an older checker does with a file that has it | This decides `/1` or `/2` (table above) |
| One honest round and one broken copy, or a description of them | Every field is added with a passing round and a broken copy in `examples/`, so the conformance kit grows with the format |

A field is added in one change that touches all of: the schema in `schema/`, `SPEC.md`, this page, the checker, and the kit (`npm run conformance:make`). `test/format.test.ts` fails if any example file uses a field the schemas do not list.
