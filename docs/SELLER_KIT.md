# Seller kit: run a checkable round

Two commands take a seller from "I want to sell something" to the two files anyone can check.

```
imani lot-new --lot LOT-01 --address <lot address> --key-file lot-key.txt --items 2 --reserve-zat 1000000 \
              --open-height 4489077 --close-height 4489085 --refund-by-height 4489110 --pricing lowest-winning --top-ups
imani settle --folder lot-LOT-01 --fetch
```

| Step | What happens |
|---|---|
| Make a fresh wallet account for this one lot | Done in your own wallet, not by Imani. Imani only reads with keys, it never makes them. You need the account's address and its read-only viewing key (starts `uview1` or `uviewtest1`). Never use an account that has other payments: the key you publish later shows every payment into it |
| `imani lot-new` | Checks the key is read-only (spending keys and seed phrases are refused), that the address is shielded, that the key and address are on the same network and that the blocks run in order. Writes `lot-public.json` (publish it: lot name, blocks, address, rules, no key), `lot-private.json` (keep it until the close: it holds the viewing key) and `CHECKLIST.md`. It never overwrites an existing file |
| Bidders bid | With `imani bid-link` (see [BID_LINK.md](BID_LINK.md)), or by hand. Writing a refund address into the bid memo is how you know where each refund goes, because a shielded payment does not show who sent it |
| `imani settle`, after the close | Reads the blocks from the open block to the refund deadline (from two public servers that must agree, or from a saved file with `--chain`), works out the winners, the price and what each bidder is owed, prints every refund to pay (amount, address from the bid memo, memo to use), and writes `settled/disclosure.json` and `settled/result.json` with the published totals filled in |
| Pay the refunds | From the lot account, one payment per bid, with the memo `refund:<lot>:<bid transaction id>` that `settle` prints |
| `imani settle` again, after the refund deadline | Now the chain holds the refunds, so the checks that compare with the chain pass. Publish the two files in `settled/` |

On the first `settle` run a FAIL on `refunds-paid` is expected: the refunds have not been paid yet.

## What was tested

`test/seller-kit.test.ts` sets up a lot with the real test-network round's key and blocks, runs `settle` and gets the same bids, winners, price and refunds as the files the seller of that round published, plus totals, and a PASS. It also runs `settle` with one refund missing from the chain: the files are written, the refund owed is listed and the exit code is 1. Setting up a lot refuses spending keys, seed phrases, transparent addresses, blocks out of order and existing files.

## What is not covered

- Imani does not make the wallet account, send payments or pay refunds. The seller does that in a wallet.
- The address and the key are not proven to belong together. The checklist has a test payment for that.
- `settle` reads plain lots. Sealed lots have their own commands (`imani seal`, `imani open`) and are settled by publishing the files for `imani check`.
