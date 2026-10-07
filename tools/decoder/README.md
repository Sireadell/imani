# decoder

Reads a raw Zcash transaction with a unified full viewing key (UFVK) and returns every
shielded output that key can see: amount, memo, and whether it came in, went out, or
stayed inside the wallet. It is a small wrapper around the official Zcash Rust library,
librustzcash (`zcash_client_backend::decrypt_transaction`), compiled to WebAssembly so
the Node project runs it with no Rust installed.

The ready-built files live in `vendor/decoder/`. Running imani only needs `npm install`.
This folder is only for people who want to rebuild those files and check they match.

## What it reads

| Transaction | Pools | Status |
|---|---|---|
| version 5, NU5 to NU6.2 rules | Orchard, Sapling | read |
| version 6, NU6.3 rules (live on mainnet since block 3,428,143) | Orchard, Ironwood, Sapling | read |
| version 4 (before NU5) | Sapling | read with the Canopy rule set, see below |

The caller gives only the transaction hex and the key:

- the network comes from the key: `uview1...` is mainnet, `uviewtest1...` is testnet;
- the transaction version and the network upgrade (consensus branch id) come from the
  first 12 bytes of the transaction itself, so no block height is needed;
- the only thing a height changes is which Sapling note format is accepted (ZIP 212).
  The decoder uses the activation height of the upgrade named in the transaction. A
  version 4 transaction carries no branch id, so it is read under Canopy, whose grace
  period accepts both Sapling note formats.

## JavaScript use

```js
const { decryptTx } = require("./vendor/decoder/imani_decoder.js");
decryptTx(txHex, ufvk);
// { txid, txVersion, branchId,
//   orchard:  [{ index, amountZat, memo, memoHex, transferType }],
//   ironwood: [...], sapling: [...] }
```

`transferType` is `"incoming"`, `"outgoing"` (found with the key's outgoing viewing key,
for example a refund the seller sent) or `"internal"` (change). `memo` is the text memo
with trailing zero bytes removed, or `""` for an empty or non-text memo; `memoHex` holds
the raw memo bytes with trailing zeros removed. A bad key or a broken transaction throws
an `Error` with a readable message.

## Rebuild from source

Needs Linux or macOS, Rust through rustup (1.88 or newer), clang, and internet access to
crates.io. The `Cargo.lock` here pins every crate to the versions that zcash-devtool commit
`5a26ee8` builds with (zcash_client_backend 0.24.0, zcash_primitives 0.30.1, orchard
0.15.3, zcash_keys 0.16.1, zcash_protocol 0.10.5).

```sh
bash tools/decoder/build.sh
```

The script installs the `wasm32-unknown-unknown` target and the matching `wasm-bindgen`
command line tool, runs the native tests against `test/vectors/offline-vectors.json`,
builds the WebAssembly, writes the JavaScript glue into `vendor/decoder/`, and prints
`vendor/decoder/SHA256SUMS`.

## Check the shipped files

From the project root:

```sh
cd vendor/decoder && sha256sum -c SHA256SUMS
```

On Windows PowerShell: `Get-FileHash vendor\decoder\* -Algorithm SHA256` and compare with
`SHA256SUMS`.

The shipped files were built with Rust 1.99.0 and wasm-bindgen 0.2.126 on a 2-core Linux
machine. A full clean rebuild there (native tests plus WebAssembly) took about 3 minutes
and gave byte-identical files, so a rebuild with the same Rust version and the same
`Cargo.lock` should give the same hashes. If your Rust version differs, the WebAssembly bytes may differ while the
behaviour stays the same; the tests in `test/` are the real check.

## Licence

This wrapper is MIT, like the rest of imani. The Zcash crates it builds on are
MIT OR Apache-2.0; see `THIRD_PARTY.md`.
