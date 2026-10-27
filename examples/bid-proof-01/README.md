# bid-proof-01: one real bid, proven with no viewing key

A proof of one bid in the real round `testnet-01` (lot DRY-01, Zcash test network): the 3,000,000 zatoshi bid in transaction `b76cd31fa4584857b84e16357e2fd6e958a59a9e63661529b52a93867ad8ed7c`, mined in block 4,489,081. The lot owner made it with the round's lot key. The file holds only that payment's opening key, which opens this one bid.

```sh
npx @sireadell/imani bid-proof check --proof examples/bid-proof-01/proof.json --facts examples/bid-proof-01/lot-public.json --result examples/testnet-01/result.json --fetch
```

Expected: `RESULT: PASS (9 of 9 lines proven)`. Use `--chain examples/testnet-01/chain.json` instead of `--fetch` to run it offline against the saved blocks.

| File | Holds |
|---|---|
| `proof.json` | The bid proof (`imani-bid-proof/1`): the lot, the bid's amount, memo and word, its block, its opening key and the raw transaction |
| `lot-public.json` | The DRY-01 lot facts, with the lot address added. The facts published with the round did not name the lot address, so this copy adds the lot's Orchard receiver, read from the bids with the round's published lot key |

To make the same proof again as the lot owner (the lot key is in `examples/testnet-01/disclosure.json`, shared on purpose for this test round; save its `ufvk` value to a file first):

```sh
npx @sireadell/imani bid-proof make --facts examples/bid-proof-01/lot-public.json --key-file lot.key --bid b76cd31fa4584857b84e16357e2fd6e958a59a9e63661529b52a93867ad8ed7c --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --out proof.json
```

See `docs/BID_PROOF.md`.
