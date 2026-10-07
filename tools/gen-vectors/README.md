# gen-vectors

Makes the offline Zcash test transactions in `test/vectors/offline-vectors.json` (reader
tests) and `test/vectors/auction-round.json` (auction checker examples).

Nothing here touches the real network. Each transaction is paid for by an invented
coin (the builder does not check that a coin exists), every key comes from a fixed
throwaway seed, and all randomness comes from a fixed seed. Running it again with the
same dependency versions gives the same bytes.

## What it makes

| Case | Network rules | What happens |
|---|---|---|
| `orchard_v5_payment` | testnet NU6.1, transaction version 5 | buyer pays seller 1,250,000 zatoshis into Orchard, with a text memo |
| `orchard_v5_refund` | testnet NU6.1, transaction version 5 | seller sends 400,000 zatoshis back to buyer, with a memo, recorded under the seller's outgoing viewing key |
| `orchard_nu6_2_payment` | testnet NU6.2, transaction version 5 | same payment as the first case, under the NU6.2 rules |
| `ironwood_v6_payment` | testnet NU6.3, transaction version 6 | same payment, into the Ironwood pool |
| `ironwood_v6_refund` | testnet NU6.3, transaction version 6 | same refund, into the Ironwood pool |

There is no Orchard payment under NU6.3: the builder refuses it, because from NU6.3
on the Orchard pool only takes the sender's own change and payments to other people
go into Ironwood.

For every case the file also stores what librustzcash itself decrypts with each
party's viewing key (`librustzcashDecrypt`), as a second opinion next to the reader
under test.

## Auction mode

`gen_vectors auction <file>` makes a fake sealed-bid round for lot `LOT-01`, all Ironwood
version 6 transactions under testnet NU6.3 rules, with throwaway keys for the lot and four
bidders. The lot sells 2 items, reserve 1,000,000 zatoshis, bids close at block 4,200,100.

| Transaction | Block | What happens |
|---|---|---|
| `bid_alice`, `bid_bob`, `bid_carol` | 4,200,010 to 4,200,030 | bids of 3,000,000, 2,000,000 and 1,500,000 into the lot address, memo `bid:LOT-01:<nonce>` |
| `bid_dave_late` | 4,200,105 | a bid of 1,200,000 that arrives after the close |
| `refund_alice_change`, `refund_bob_change` | 4,200,120, 4,200,121 | winners get back their bid minus the 1,500,000 clearing price |
| `refund_carol`, `refund_dave_late` | 4,200,122, 4,200,123 | the loser and the late bidder get their whole bid back |
| `refund_carol_short` | 4,200,122 | Carol refunded 100,000 too little, only for a broken copy |
| `stray_payment`, `bid_other_lot`, `bid_alice_replay` | 4,200,040 to 4,200,060 | a payment that is not a bid, a bid for another lot, and a replay of Alice's bid memo, only for guard tests |

Refunds are paid from the lot and recorded under the lot's outgoing viewing key, with memo
`refund:LOT-01:<bid txid>`. `node tools/make-examples.ts` (or `npm run examples`) then turns
this file into `examples/round-01`, the six broken copies in `examples/broken` and the guard
cases in `examples/guards`.

## How to run it

It is a single Rust file that borrows the dependency set of
[zcash-devtool](https://github.com/zcash/zcash-devtool) (MIT OR Apache-2.0), which
pins the librustzcash crates (zcash_primitives, orchard, zcash_keys, zcash_protocol,
zcash_transparent, zcash_proofs, zcash_client_backend). It was run against
zcash-devtool commit `5a26ee8` (zcash_primitives 0.30.1, orchard 0.15.3).

```sh
git clone https://github.com/zcash/zcash-devtool
cd zcash-devtool
git checkout 5a26ee8
mkdir -p examples
cp /path/to/imani/tools/gen-vectors/gen_vectors.rs examples/
cargo run --release --example gen_vectors -- offline-vectors.json
cargo run --release --example gen_vectors -- auction auction-round.json
cp offline-vectors.json auction-round.json /path/to/imani/test/vectors/
```

A debug build creates the proofs slowly (several minutes). With `--release` the auction
round takes about 2 minutes on a 2-core machine including the compile. Two runs on
2026-10-07 gave byte-identical files (auction-round.json sha256 `f5fb9e20...d020`).
