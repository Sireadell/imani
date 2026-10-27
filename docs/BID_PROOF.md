# Bid proof: show one bid to someone who has no viewing key

A bidder sometimes needs to show a third party (a friend, an arbiter, a platform, a judge) that one particular bid reached the lot and was counted. Until now the only way was to hand over the lot's viewing key, which shows every bid in the round, or the bidder's own viewing key, which shows their whole wallet. A bid proof shows one bid and nothing else.

The file format is `imani-bid-proof/1`, with a JSON Schema in [`schema/bid-proof.schema.json`](../schema/bid-proof.schema.json). It holds no viewing key, and a checker refuses any file with a field the format does not define, so a key cannot ride along by accident.

## How it works

Every Orchard and Ironwood payment on Zcash is encrypted with its own one-time secret. The Zcash protocol calls it the ephemeral secret key; Imani calls it the payment's **opening key**. It is 32 bytes and opens that one payment: its amount, its memo and the address it was paid to. It does not open any other payment in the same transaction or anywhere else.

Two people can work out the opening key of a bid. The lot owner can, for every bid, because the lot's viewing key reads every payment into the lot. The bidder can, for their own bid, if their wallet kept a copy of what it sent under the wallet's outgoing viewing key. Whoever makes it, the proof is the same file.

A checker opens the payment with the official Zcash library (librustzcash, compiled to WebAssembly in `vendor/disclose/`). The library refuses to open it unless the opened amount, memo and receiver match the commitments fixed in the transaction. So a made-up opening key, a changed amount or a different lot address never passes. The checker then confirms the transaction's block from the chain, and looks for the bid in the seller's published result.

The idea is the same as the payment disclosures in ZIP 311, applied to one auction bid.

## Make a proof

The lot owner, with the lot's viewing key and their own disclosure file:

```sh
npx @sireadell/imani bid-proof make --facts lot-public.json --key-file lot-viewing-key.txt \
  --bid <bid txid> --disclosure disclosure.json --result result.json --out proof.json
```

Instead of `--disclosure`, the transaction can come from a saved chain file (`--chain <file>`) or from two public servers run by different people (`--fetch`). `--result` is optional: it records which published result file the proof was made against. The viewing key is used on this machine and is never written into the proof.

## Check a proof

No key is needed:

```sh
npx @sireadell/imani bid-proof check --proof proof.json --facts lot-public.json --result result.json --fetch
```

| Line | PROVEN when |
|---|---|
| `txid-matches-bytes` | The transaction id recomputed from the bytes in the proof is the bid's id |
| `payment-opens` | The opening key opens that payment as a payment to the lot address |
| `bid-amount` | The opened amount is the amount the proof states |
| `bid-memo` | The opened memo is the stated memo, a bid for this lot, with the stated word |
| `lot-facts` | The lot id, network, lot address and close height match the seller's published lot facts (`--facts`) |
| `mined-height` | The transaction is in the stated block, read from your chain file (`--chain`) or two servers (`--fetch`) |
| `on-time` | That block is inside the bidding window |
| `counted` | The seller's published result (`--result`) lists this bid at this amount |
| `result-file` | When the proof recorded a result file: the one you gave is the same file |

Each line is PROVEN, FAIL, GIVEN (it rests on the proof file's word) or NOT CHECKED (nothing was given to check it against). The result is PASS only when every line is PROVEN. Without `--facts`, `--result` and `--chain` or `--fetch`, a correct proof says NOT PROVEN, never PASS. Exit codes: 0 PASS, 1 FAIL, 3 NOT PROVEN, 2 bad input.

The report also prints what the seller's result says about the bid (won or not, the price, the refund), marked as the seller's word.

## What this is not

| A bid proof does not | Why |
|---|---|
| Prove who paid | It proves a payment. Anyone holding the file can show it, like a receipt |
| Show that the round was fair | `counted` means the seller's published result lists the bid at the right amount. Whether the winners, price and refunds are right needs the full check of the round (`imani check`) |
| Show the other bids | The opening key opens one payment. Other bids, refunds and the bidder's own change in the same transaction stay sealed |
| Show where the lot later sends the money | Opening a payment does not give the lot's nullifier key, so a checker cannot tell when the lot spends it |
| Cover sealed lots | A sealed bid is a deposit and a later opening, two payments. Version 1 refuses a sealed lot's result |
| Cover top-up lots fully | With top-ups several payments add up to one bid. When the seller's amount differs from this one payment, `counted` says NOT CHECKED |
| Cover Sapling payments | Only Orchard and Ironwood (transaction versions 5 and 6), which is where current wallets pay |
| Hide the bid from the person you show it to | They learn the amount, the memo (with the word and any refund address written in it) and the block |
| Make `--chain` trustworthy by itself | A chain file is whatever is in the file. Use `--fetch`, or a chain file you got yourself, not one handed over with the proof |

## Real run

`examples/bid-proof-01/` holds a proof of a real bid: 3,000,000 zatoshis in lot DRY-01 on the Zcash test network (transaction `b76cd31fa4...`, block 4,489,081), made by the lot owner with the round's published lot key. Checked on 2026-10-27 against the live test network, with no key:

```text
$ npx @sireadell/imani bid-proof check --proof examples/bid-proof-01/proof.json --facts examples/bid-proof-01/lot-public.json --result examples/testnet-01/result.json --fetch
  [PROVEN] mined-height: Transaction b76cd31fa4 is in block 4489081, read from testnet.zec.rocks and api.testnet.cipherscan.app.
RESULT: PASS (9 of 9 lines proven)
Servers contacted: https://testnet.zec.rocks:443, cipherscan:https://api.testnet.cipherscan.app
```

It took about 4 seconds. The same check offline against the saved blocks (`--chain examples/testnet-01/chain.json`) also passes. The opening key in that file opens the 3,000,000 bid and nothing else: the round's two other bids and three refunds stay closed to whoever holds only the proof.

## Tested

`test/bid-proof.test.ts`, 26 tests. Honest proofs pass on the offline round LOT-01 and on the real round DRY-01, and the lot owner remaking the DRY-01 proof gets the identical file. 18 tampered copies each fail on the line that owns the fault:

| Change | Fails on |
|---|---|
| One byte of the encrypted payments changed | `txid-matches-bytes` |
| Another bid's transaction id | `txid-matches-bytes` |
| Amount raised | `bid-amount` |
| Another word claimed | `bid-memo` |
| Another bid's opening key | `payment-opens` |
| A made-up opening key | `payment-opens` |
| The other payment in the transaction | `payment-opens` |
| A stranger's address as the lot address | `payment-opens`, `lot-facts` |
| Close moved later than published | `lot-facts` |
| Block number changed | `mined-height` |
| A late bid, honestly proven | `on-time`, `counted` |
| A late bid with an on-time block claimed | `mined-height` |
| A bid that never reached the chain | `mined-height` |
| Seller's result leaves the bid out | `counted` |
| Seller's result counts it at less | `counted` |
| A different result file from the one the proof was made against | `result-file` |
| Moved to another lot name | `bid-memo`, `lot-facts` |
| Another bid's bytes under this bid's opening key | `payment-opens` |

A proof with an extra field (for example a viewing key) is refused as bad input, and a key that cannot see the bid cannot make a proof.

## Limits, said plainly

- Only the lot-owner path has been run on a real round. The bidder path uses the same code, but the bidders' wallet keys for DRY-01 are not in this repository, and in the offline round the bidders paid without keeping a sender copy, so a bidder-made proof has not yet been run on a real wallet.
- The opening-key reader in `vendor/disclose/` was built on Windows with `zig cc` for the C part of the Zcash crates; the main decoder in `vendor/decoder/` was built on Linux. Both use the same librustzcash versions. Rebuild steps: `tools/disclose/README.md`.
- The lot facts for DRY-01 were published without the lot address, so `examples/bid-proof-01/lot-public.json` is a copy with the address added: the lot's Orchard receiver, read from the bids with the round's published lot key.
