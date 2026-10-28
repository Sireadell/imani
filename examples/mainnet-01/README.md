# mainnet-01: a small real round on Zcash mainnet

This one used real ZEC. A real wallet paid 3 bids into a fresh lot account on Zcash mainnet on 2026-10-27, and the lot paid 3 refunds back. Lot id `IMANI-M1`, 2 items, reserve 100,000 zatoshis. The round is small on purpose: the bids add up to 0.013 ZEC. All six payments are in the Ironwood pool.

All 3 bids were paid from 3 separate wallets, which we ran ourselves, and we also ran the lot. So this round shows the checker working on real mainnet data. It does not show independent bidders.

```sh
node bin/imani.js check --disclosure examples/mainnet-01/disclosure.json --result examples/mainnet-01/result.json --scan --chain examples/mainnet-01/chain.json
```

Expected: `RESULT: PASS (23 of 23 checks passed)`. The scan reads all 61 blocks from 3,532,593 to 3,532,653 (482 transactions) and the lot key sees exactly the 6 below.

## The 6 payments

Each one can be looked up on a public mainnet explorer. The explorer shows that the payment exists and its block. The amounts and memos are private and only show up with the lot key.

| Payment | Amount (ZEC) | Block | Explorer |
|---|---|---|---|
| Bid | 0.006 | 3,532,597 | [a41364b6cf](https://mainnet.zcashexplorer.app/transactions/a41364b6cf4d426c3a6bea2092f9365534a2f79c1f28ec9b29a2e6a3b46b7b43) |
| Bid | 0.004 | 3,532,597 | [25296f4012](https://mainnet.zcashexplorer.app/transactions/25296f4012e9bd160d315f4ebef421ee0852718d08731d020510319fdd9b0f4f) |
| Bid | 0.003 | 3,532,597 | [ded6553a39](https://mainnet.zcashexplorer.app/transactions/ded6553a396bc4f76938cd59e8c14fb684f2298e1d98897d098b497929b81c22) |
| Refund (change) to the 0.006 bid | 0.003 | 3,532,618 | [9b8ff3bacf](https://mainnet.zcashexplorer.app/transactions/9b8ff3bacf47b514ec723a84aec0615c5bb48408bf7f01a99721db4a91c37bf0) |
| Refund (change) to the 0.004 bid | 0.001 | 3,532,618 | [711ee09358](https://mainnet.zcashexplorer.app/transactions/711ee0935873a08da6ac3ec032c66ec660aef1732e5eab3cda006f99fcbf5828) |
| Refund to the losing 0.003 bid (in full) | 0.003 | 3,532,624 | [25381f8eef](https://mainnet.zcashexplorer.app/transactions/25381f8eef3c352d265d2b4cc09221c16f7c934bbfd465000e242434c009fdb2) |

The two top bids win and both pay the clearing price of 0.003 ZEC (300,000 zatoshis, the highest losing bid). Each bid memo ends with a refund address, and each refund went to the address in its bid's memo.

## Re-run it from the chain yourself

`chain.json` is a saved copy of the blocks. To fetch the same blocks from two public mainnet servers run by different people instead of trusting the file:

```sh
node bin/imani.js check --disclosure examples/mainnet-01/disclosure.json --result examples/mainnet-01/result.json --scan --fetch
```

## What is in the files

| File | Holds |
|---|---|
| `disclosure.json` | The lot's read-only viewing key, the open, close and refund heights, and the raw bytes of the 6 payments |
| `result.json` | The seller's claimed bids, winners, price and refunds |
| `chain.json` | Every block of the auction, as served by two public mainnet light servers that agreed on every byte |

The viewing key can read this lot's payments and cannot spend. It is published on purpose so anyone can run the check. That means anyone can read every bid amount and refund address in this lot, and everything else the account received and sent. The lot account was fresh and was used for this one round only. The key also shows the lot's own outgoing payments, including the leftover coins moved out after the round. No spending key and no other wallet's key is in the repo.
