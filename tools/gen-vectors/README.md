# gen-vectors

Makes the offline Zcash test transactions in `test/vectors/offline-vectors.json`.

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
cargo run --example gen_vectors -- offline-vectors.json
cp offline-vectors.json /path/to/imani/test/vectors/
```

A debug build creates the Orchard proofs slowly (several minutes). `cargo run --release`
is faster if you have the time to compile once.
