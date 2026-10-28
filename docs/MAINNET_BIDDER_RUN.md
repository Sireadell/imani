# Real-wallet run of `imani bidder-check` on mainnet-01

No new payment is needed. The wallet that paid the 3 bids on 2026-10-27 already has them, and it also received the 3 refunds. This run only reads.

Do this in the VS Code session that holds that bidder wallet. Never paste a seed phrase or spending key anywhere. Only the read-only viewing key (starts with `uview1`) is used.

## Steps

1. In the bidder wallet, export its unified full viewing key (UFVK) to a file outside the repo, for example `~/bidder-ufvk.txt`. Do not commit it. `npm run leak-scan` would flag it.
2. In the repo, `git pull`, then `npm install`.
3. Run, once per bid, with the amount that wallet paid:

```sh
node bin/imani.js bidder-check --facts examples/mainnet-01/lot-public.json --key-file ~/bidder-ufvk.txt --fetch --bid a41364b6cf4d426c3a6bea2092f9365534a2f79c1f28ec9b29a2e6a3b46b7b43:600000
node bin/imani.js bidder-check --facts examples/mainnet-01/lot-public.json --key-file ~/bidder-ufvk.txt --fetch --bid 25296f4012e9bd160d315f4ebef421ee0852718d08731d020510319fdd9b0f4f:400000
node bin/imani.js bidder-check --facts examples/mainnet-01/lot-public.json --key-file ~/bidder-ufvk.txt --fetch --bid ded6553a396bc4f76938cd59e8c14fb684f2298e1d98897d098b497929b81c22:300000
```

   `--fetch` downloads 71 blocks from two mainnet servers that must agree. Use `--chain examples/mainnet-01/chain.json` instead for the saved copy, offline.

4. Optional, to compare with the seller's published answer, add `--result examples/mainnet-01/result.json` to each command.

## What a good run looks like

| Bid | Expect |
|---|---|
| 0.006 ZEC | landed in block 3,532,597. A refund of 0.003 reached the wallet in block 3,532,618. Won, and paid the price of 0.003 |
| 0.004 ZEC | landed in block 3,532,597. A refund of 0.001 reached the wallet in block 3,532,618. Won, and paid the price of 0.003 |
| 0.003 ZEC | landed in block 3,532,597. The whole 0.003 came back in block 3,532,624. Lost |

The clearing price can't be proven from one bidder's key, so a result of `NOT PROVEN` on that point is correct. A `FAIL` or `refused` is the thing to report.

## Report back

- The `RESULT:` line of each run, and whether the amount line says `PROVEN` or `GIVEN` (`GIVEN` means the wallet doesn't keep the sender view).
- If it all works, tell me so I can change "has not been tried on a real wallet" to "tried on a real mainnet wallet" in the README and the video lines. Until then those docs say it hasn't been tried.
