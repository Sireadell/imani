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
| `imani settle`, after the close | Reads the blocks from the open block to the refund deadline, or to the newest block if the deadline has not come yet (from two public servers that must agree, or from a saved file with `--chain`). Works out the winners, the price and what each bidder is owed, prints every refund to pay (amount, address from the bid memo, memo to use), and writes `settled/disclosure.json` and `settled/result.json` with the published totals filled in |
| Pay the refunds | From the lot account, one payment per bid, with the memo `refund:<lot>:<bid transaction id>` that `settle` prints |
| `imani settle` again, after the refund deadline | Now the chain holds the refunds, so the checks that compare with the chain pass. Publish the two files in `settled/` |

On the first `settle` run a FAIL is expected. The refunds have not been paid yet (`refunds-paid`), and with `--fetch` the blocks up to the refund deadline do not exist yet, so `settle` says which blocks it read and that refunds due later are not covered (`scan-blocks-read`). Only the run after the deadline can pass.

## Show the result on your lot page

Once your round passes, put the badge on your lot page: it shows the result of the latest check of your published files.

```html
<img src="https://imani-check.vercel.app/api/check?round=testnet-01&format=svg" alt="Imani: testnet-01 checked fair, 21 of 21 checks passed" width="204" height="24">
```

The badge is a small picture made from the same check the page runs. It holds the result and the check count, nothing else. If a round fails, the same address returns a red badge that says FAIL. Today the address only answers for the rounds shipped with Imani, so a seller's own round gets a badge once it is added to that list. Anyone who clicks can open the checker and run the check themselves.

## What was tested

`test/seller-kit.test.ts` sets up a lot with the real test-network round's key and blocks, runs `settle` and gets the same bids, winners, price and refunds as the files the seller of that round published, plus totals, and a PASS. It also runs `settle` with one refund missing from the chain: the files are written, the refund owed is listed and the exit code is 1. `test/settle-early.test.ts` runs `settle --fetch` against two fake servers whose newest block is between the close and the refund deadline: it reads only up to that block, never asks for a later one, lists the 3 refunds owed, says the rest of the window is not covered, and exits 1. At the deadline it passes, and before the close it is refused. Setting up a lot refuses spending keys, seed phrases, transparent addresses, blocks out of order and existing files.

## What is not covered

- Imani does not make the wallet account, send payments or pay refunds. The seller does that in a wallet.
- The address and the key are not proven to belong together. The checklist has a test payment for that.
- `settle` reads plain lots. Sealed lots have their own commands (`imani seal`, `imani open`) and are settled by publishing the files for `imani check`.
