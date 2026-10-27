# The imani library

Everything the command line and the checker page do is also a plain function you can call from your own code. `import { ... } from "imani"` gives you the names below. Only one of them, `fetchTransactions`, opens a network connection, and only when you call it. No function takes a spending key or a seed phrase.

imani is not on the npm registry yet. To use it in another project, run `npm pack` in this folder, then `npm install <path to the .tgz file>` in yours. It needs Node 22.18 or newer and installs with no other packages.

## Check a round in 10 lines

```js
import { readFileSync } from "node:fs";
import { checkLot } from "imani";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const verdict = checkLot(read("examples/testnet-01/disclosure.json"), read("examples/testnet-01/result.json"));

console.log(verdict.result); // "PASS" or "FAIL"
for (const id of verdict.failed) console.log("failed:", id);
for (const c of verdict.checks) console.log(c.status, c.id, c.reason);
// The same files from a seller who cheated give "FAIL" and name the check, for example refunds-paid.
```

The same example, ready to run from this folder: `npm run build`, then `node examples/library/check-a-round.mjs`. It prints `DRY-01: PASS (16 of 16 checks passed)`.

## Every export

"Network" says whether the function talks to any server. Amounts are in zatoshis (1 ZEC = 100,000,000 zatoshis).

| Name | What it takes | What it gives back | Network |
|---|---|---|---|
| `checkLot` | The seller's disclosure file and result file (as parsed JSON), and optional `CheckOptions` | A `Verdict`: PASS or FAIL, and every check with its id and a one-line reason. With the lot's viewing key in the disclosure it also reads the payments themselves | none |
| `validateFiles` | A disclosure file and a result file | Nothing if both have the right shape. Throws `InputError` with a plain message if not | none |
| `assertViewingKey` | A key and the network (`"main"` or `"test"`) | The key, trimmed, if it is a read-only unified full viewing key (ZIP 316, `uview1` or `uviewtest1`) for that network. Throws `KeyRefusedError` for a spending key, a seed phrase or the wrong network | none |
| `keyFingerprint` | A key | A 12-character short hash, so two people can tell they used the same key without showing it | none |
| `InputError` | | The error thrown when a file is missing a field or has a wrong value. Its message is safe to print | none |
| `KeyRefusedError` | | The error thrown when a key is not a read-only viewing key | none |
| `readTransaction` | A raw transaction (hex) and a viewing key | Every Orchard, Ironwood and Sapling payment that key can see in it: amount, memo, whether it came in or went out, and who it was paid to. Runs librustzcash, compiled to WebAssembly | none |
| `readTransactionWithId` | A raw transaction (hex) and a viewing key | The same payments, plus the transaction id worked out from the bytes | none |
| `parseAddress` | A unified address (`u1`, `utest1`) or a Sapling address | Its network and its Orchard and Sapling receivers. Throws for a transparent address | none |
| `decoderInfo` | Nothing | The librustzcash crate versions built into the reader, and the newest network upgrade it can read (NU7) | none |
| `decide` | A list of bids and the lot's rules | The winners, the price every winner pays, whether the reserve was met, and what each bid is owed back | none |
| `groupBidPayments` | Bid payments sorted by block, a top-ups yes or no, and the closing block | The payments that count as bids, and the repeats that are owed back in full | none |
| `validateChainFile` | A saved block file (parsed JSON) | Nothing if it is a valid block file. Throws a plain error if not | none |
| `fetchTransactions` | `FetchOptions`: the network, and transaction ids or block numbers. Optionally your own servers, a proxy, a time limit | The raw transactions, each checked against its id, and the list of every server contacted. By default two servers run by different people must send the exact same bytes. Throws `FetchError` if that cannot be done | **yes**, to public Zcash block servers, or to your own lightwalletd server or Zebra node |
| `DEFAULT_SERVERS` | | The public servers `fetchTransactions` asks when you give none, per network | none |
| `FetchError` | | The error thrown when the downloads cannot be checked. It still carries the list of servers contacted | none |
| `makeBidLink` | A lot name, the lot's address, an amount, and optionally a refund address or a ready-made memo | A ZIP 321 `zcash:` payment link, its memo and amount in ZEC. A wallet that reads the link fills in all three | none |
| `qrSvg` | Any text, and an optional size | A QR code of the text as an SVG picture | none |
| `qrText` | Any text | The same QR code drawn with text characters, for a terminal | none |
| `zatToZec` | A whole number of zatoshis | The amount in ZEC as text, for example `"0.015"` | none |
| `zecToZat` | An amount in ZEC as text | The whole number of zatoshis, or `null` if the text is not a valid amount | none |
| `BidLinkError` | | The error thrown when a bid link cannot be made, with the reason | none |
| `bidderCheck` | A lot's public facts, the bidder's own viewing key, the blocks of the round, and optionally the seller's result | For each of the bidder's bids: counted or not, won or not, what should come back and whether it did. Needs no help from the seller | none |
| `makeBidProof` | The lot's public facts, a viewing key that can see one bid (the lot's, or the bidder's own), the bid's transaction id, its raw bytes and its block | An `imani-bid-proof/1` file as a value: that bid's amount, memo and word, and the opening key of that one payment. The viewing key is not in it. Throws `BidProofError` if the key cannot see a bid to the lot in that transaction | none |
| `verifyBidProof` | A bid proof, and optionally the seller's published lot facts, result file and where the transaction was mined (`MinedAt`) | A `BidProofReport`: each line PROVEN, GIVEN, NOT CHECKED or FAIL, and PASS only when every line is proven. Needs no viewing key | none |
| `validateBidProof` | A parsed bid proof file | Nothing if it is well formed. Throws `InputError` if not, including for any field the format does not define | none |
| `bidProofText` | A `BidProofReport` | The report as plain text, the same as `imani bid-proof check` prints | none |
| `BidProofError` | | The error thrown when a bid proof cannot be made, with the reason | none |
| `BID_PROOF_FORMAT` | | The format string `"imani-bid-proof/1"` | none |
| `planLot` | A lot name, address, viewing key, item count, reserve, price rule and block heights | The lot's public file, private file and a checklist, as values. It writes nothing to disk | none |
| `settle` | A lot folder made by `planLot` (read from disk) and the blocks of the round | The disclosure file and result file to publish, the verdict on them, and each bid's memo | none |
| `settleRange` | A lot folder made by `planLot` | The network and the first and last block a settlement must read | none |
| `toText` | A `Verdict` | The report as plain text, the same as the command line prints | none |
| `toHtml` | A `Verdict` | The report as one web page that opens offline | none |
| `Verdict` | type | What `checkLot` returns: `result`, the result of each level, `failed` (the ids of failed checks), `checks`, and `serversContacted` | |
| `Check` | type | One check: `id`, `level` (1 basic, 2 with the key, 3 every block), `title`, `status`, `reason`, and the numbers read from the chain | |
| `CheckOptions` | type | `basicOnly`, `discreet` (hide amounts and memos) and `scan` (the blocks to read every payment from) | |
| `Status` | type | `"PASS"` or `"FAIL"` | |
| `SealedSummary` | type | For a sealed lot: how many seals were paid, counted, never opened, and opened wrongly | |
| `Disclosure` | type | The seller's disclosure file: lot name, network, closing block, rules, the lot's viewing key and the raw transactions | |
| `SellerResult` | type | The seller's result file: bids, winners, price, reserve met or not, refunds | |
| `AuctionRules` | type | Item count, reserve, price rule and top-ups for a normal lot | |
| `PricingRule` | type | `"highest-losing"` or `"lowest-winning"` | |
| `SealedRules` | type | Item count, reserve, deposit and penalty for a sealed lot | |
| `PublishedTotals` | type | The headline totals a seller can publish: payments, received, kept, refunded | |
| `ReadOutput` | type | One payment read by `readTransaction`: pool, amount, memo, direction, receiver | |
| `ParsedAddress` | type | What `parseAddress` returns | |
| `Bid` | type | A bid for `decide`: transaction id, amount, block | |
| `Outcome` | type | What `decide` returns | |
| `ChainFile` | type | A saved stretch of blocks, so a check can run with no network | |
| `ChainBlock` | type | One block: its height and its transactions | |
| `ChainTx` | type | One transaction in a block: its id and raw bytes | |
| `BlockSource` | type | Where blocks came from, how many bytes and how long it took | |
| `FetchOptions` | type | What `fetchTransactions` takes | |
| `FetchResult` | type | What `fetchTransactions` returns | |
| `Network` | type | `"main"` or `"test"` | |
| `BidLink` | type | What `makeBidLink` returns | |
| `BidLinkInput` | type | What `makeBidLink` takes | |
| `BidderReport` | type | What `bidderCheck` returns | |
| `BidProof` | type | The bid proof file, `imani-bid-proof/1`. Schema: `schema/bid-proof.schema.json` | |
| `BidProofReport` | type | What `verifyBidProof` returns: the result, each line, what the seller's result says about the bid, and the servers contacted | |
| `MakeBidProofInput` | type | What `makeBidProof` takes | |
| `VerifyOptions` | type | What `verifyBidProof` takes besides the proof: lot facts, result file and its bytes, and `MinedAt` | |
| `MinedAt` | type | Where a transaction was mined, read from a chain file or from servers you trust: block, found or not, and the source | |
| `LotNewInput` | type | What `planLot` takes | |
| `LotNewFiles` | type | What `planLot` returns | |
| `Settlement` | type | What `settle` returns | |

The sign-in kit is a separate import, `imani/login`. Its format is in [LOGIN_SPEC.md](../LOGIN_SPEC.md).
