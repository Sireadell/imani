# testnet-01: a real round on the Zcash test network

Every other example here was built offline with throwaway keys. This one was not. A real wallet (zecd 0.9.0-rc1) paid 3 bids into a fresh lot account on the public Zcash test network on 2026-10-11, and the lot paid 3 refunds back. Lot id `DRY-01`, 2 items, reserve 1,000,000 zatoshis. Test coins came from a public faucet and have no value.

```sh
node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --chain examples/testnet-01/chain.json
```

Expected: `RESULT: PASS (21 of 21 checks passed)`. The scan reads all 34 blocks from 4,489,077 to 4,489,110 (80 transactions) and the lot key sees exactly the 6 below.

## The 6 payments

Each one can be looked up on a public test-network explorer. The explorer shows that the payment exists and its block. The amounts and memos are private and only show up with the lot key.

| Payment | Amount (zatoshis) | Block | Explorer |
|---|---|---|---|
| Bid | 3,000,000 | 4,489,081 | [b76cd31fa4](https://testnet.zecblock.com/tx/b76cd31fa4584857b84e16357e2fd6e958a59a9e63661529b52a93867ad8ed7c) |
| Bid | 2,000,000 | 4,489,081 | [f7eb067b88](https://testnet.zecblock.com/tx/f7eb067b88785df5c22c9522e576a422932c853164d3d8fa69eb7a7665876b0a) |
| Bid | 1,500,000 | 4,489,081 | [2f5e8f4f37](https://testnet.zecblock.com/tx/2f5e8f4f37650d415dc42867eeda74c70eb06924c117769de048fc5c158d7505) |
| Refund to the 3,000,000 bid (change) | 1,500,000 | 4,489,096 | [1f5c2746c2](https://testnet.zecblock.com/tx/1f5c2746c2226328f7acc8549db6c058183bf7a82d2c4ec90d8d92aaf57b8f1c) |
| Refund to the 2,000,000 bid (change) | 500,000 | 4,489,100 | [f0056ba9a7](https://testnet.zecblock.com/tx/f0056ba9a72d113172d18e4da152cbf49227cdc36100708e73c723b78fef027f) |
| Refund to the losing bid (in full) | 1,500,000 | 4,489,100 | [cca33721eb](https://testnet.zecblock.com/tx/cca33721ebe9a965850029aabb79301a9b7db33d02f6b82ec9f539b474189fb3) |

The two top bids win and both pay the clearing price of 1,500,000 (the highest losing bid). Each bidder wrote their own refund address at the end of their bid memo, and each refund went to that address.

## Re-run it from the chain yourself

`chain.json` is a saved copy of the blocks. To fetch the same blocks from public test-network servers instead of trusting the file:

```sh
node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --fetch
```

## What is in the files

| File | Holds |
|---|---|
| `disclosure.json` | The lot's read-only viewing key (a test-network key made for this round, shared on purpose so anyone can check it), the open, close and refund heights, and the raw bytes of the 6 payments |
| `result.json` | The seller's claimed bids, winners, price and refunds |
| `chain.json` | Every block of the auction, as served by the test-network light server |

`examples/testnet-broken/` has two copies where the seller changed their own files. The chain cannot be changed, so both are checked against the real `chain.json`, and both fail. `node tools/make-testnet-examples.ts` rebuilds them.
