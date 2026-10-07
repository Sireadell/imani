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
| version 5 and 6, NU7 rules, branch id `0x77190ad9` (testnet since block 4,465,026; mainnet height not set yet) | Orchard, Ironwood, Sapling | read |
| version 4 (before NU5) | Sapling | read with the Canopy rule set, see below |
| any upgrade newer than NU7 | | refused with `unsupported network upgrade 0x........` |

NU7 brings no new transaction format (ZIP 259): version 5 and 6 transactions stay as they
are and only the branch id in the header changes. So a decoder that knows the NU7 branch id
reads NU7 transactions. Version 4 transactions are invalid on chain from NU7 on.

The caller gives only the transaction hex and the key:

- the network comes from the key: `uview1...` is mainnet, `uviewtest1...` is testnet;
- the transaction version and the network upgrade (consensus branch id) come from the
  first 12 bytes of the transaction itself, so no block height is needed;
- the only thing a height changes is which Sapling note format is accepted (ZIP 212).
  The decoder uses the activation height of the upgrade named in the transaction. A
  version 4 transaction carries no branch id, so it is read under Canopy, whose grace
  period accepts both Sapling note formats. If this build does not know the activation
  height yet (NU7 on mainnet until its date is set), it uses the newest earlier upgrade's
  height; every upgrade from NU5 on has the same Sapling rule, so the result is the same.

## JavaScript use

```js
const { decryptTx, decoderInfo } = require("./vendor/decoder/imani_decoder.js");
decryptTx(txHex, ufvk);
// { txid, txVersion, branchId, upgrade: "NU7",
//   shape: { transparentInputs, transparentOutputs, saplingSpends, saplingOutputs,
//            orchardActions, ironwoodActions },
//   orchard:  [{ index, amountZat, memo, memoHex, transferType }],
//   ironwood: [...], sapling: [...] }
decoderInfo();
// { decoder: "0.1.0",
//   librustzcash: { zcash_client_backend: "0.25.0-pre.1", zcash_primitives: "0.31.0-pre.1", ... },
//   highestUpgrade: "NU7", highestBranchId: "0x77190ad9", transactionVersions: [4, 5, 6],
//   upgrades: [{ name, branchId, activationHeight: { main, test } }, ...] }
```

`decoderInfo()` reads the crate versions from `Cargo.lock` at build time (see `build.rs`), so
it always reports what was really compiled in. From TypeScript use `decoderInfo()` in
`src/read.ts`.

`transferType` is `"incoming"`, `"outgoing"` (found with the key's outgoing viewing key,
for example a refund the seller sent) or `"internal"` (change). `memo` is the text memo
with trailing zero bytes removed, or `""` for an empty or non-text memo; `memoHex` holds
the raw memo bytes with trailing zeros removed. A bad key or a broken transaction throws
an `Error` with a readable message. Keys may be ZIP 316 revision 0 (`uview1`, `uviewtest1`)
or revision 2 (`uvf1`, `uvftest1`).

## Rebuild from source

Needs Linux or macOS, Rust through rustup (1.88 or newer), clang, and internet access to
crates.io.

### Which librustzcash, and why a pre-release

Checked on 2026-10-07 on crates.io and github.com/zcash/librustzcash:

| Crate | Newest full release | Knows NU7? | Used here |
|---|---|---|---|
| zcash_protocol | 0.10.6 | only a placeholder id `0xffffffff` behind an unstable flag | 0.11.0-pre.0 (real id `0x77190ad9`, testnet height 4,465,026) |
| zcash_primitives | 0.30.1 | no | 0.31.0-pre.1 |
| zcash_client_backend | 0.24.0 | no | 0.25.0-pre.1 |
| zcash_keys | 0.16.1 | no | 0.17.0-pre.1 |
| orchard | 0.16.0 | (no branch logic) | 0.16.0 |

No full release knows NU7 yet, so `Cargo.toml` pins these crates.io pre-releases exactly
(`=0.31.0-pre.1` and so on). They were cut from librustzcash commit `eb3e586765` (2026-10-06).
zcash-devtool `main` (commit `5a26ee8`) still builds with the 0.24 / 0.30 releases, so it
cannot read NU7 either. When full releases that know NU7 appear (likely after the mainnet NU7
height is set), move to them with `cargo update` after changing the pins.

Two other changes came with these versions:

- `rand` 0.10 pulls in `getrandom` 0.4, which needs its `wasm_js` feature to compile to
  WebAssembly. `Cargo.toml` turns it on for the wasm target only; the decoder never draws
  random numbers.
- `zcash_client_backend` 0.25 tries every outgoing viewing key of the account on every pool.
  A payment sent from Orchard to a Sapling address is now found as `outgoing`. The old
  Ledger testnet sample in `test/vectors` shows this: it now also returns the 1,000,000
  zatoshi Sapling payment it made.

```sh
bash tools/decoder/build.sh
```

The script installs the `wasm32-unknown-unknown` target and the matching `wasm-bindgen`
command line tool, runs the native tests (`tests/vectors.rs` against
`test/vectors/offline-vectors.json`, and `tests/nu7.rs` against `test/vectors/nu7-offline.json`,
the real NU7 testnet transactions in `test/vectors/nu7-testnet.json` and an invented branch id),
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
machine. A full clean rebuild there (native tests plus WebAssembly) took 3 minutes 24 seconds
on 2026-10-07 and gave byte-identical files, so a rebuild with the same Rust version and the same
`Cargo.lock` should give the same hashes. If your Rust version differs, the WebAssembly bytes may differ while the
behaviour stays the same; the tests in `test/` are the real check.

## NU7 test vectors

`tools/gen-vectors/gen_nu7.rs` builds two offline Ironwood transactions under testnet NU7
rules (height 4,470,000): a payment with a memo and a refund recorded under the seller's
outgoing key. It uses the same throwaway seeds as `gen_vectors.rs`. Its manifest and lock file
are in `tools/gen-vectors/nu7/`, pinned to the same pre-releases as the decoder:

```sh
cargo run --release --manifest-path tools/gen-vectors/nu7/Cargo.toml -- test/vectors/nu7-offline.json
```

About 15 seconds after the compile on a 2-core machine. Two runs gave byte-identical files
(sha256 `98d3423b...7c48`).

## Checking for the next upgrade

`node --import tsx tools/decoder/check-upgrade.ts --network main` asks public light wallet
servers for the current consensus branch id and the next scheduled upgrade, and compares them
with `decoderInfo()`. See `docs/UPGRADES.md`.

## Licence

This wrapper is MIT, like the rest of imani. The Zcash crates it builds on are
MIT OR Apache-2.0; see `THIRD_PARTY.md`.
