# disclose

Opens one shielded Zcash payment with that payment's own opening key, so a bid can be proven to someone who holds no viewing key. It is a small wrapper around the official Zcash Rust library, librustzcash, compiled to WebAssembly. `src/bid-proof.ts` uses it; see `docs/BID_PROOF.md`.

The ready-built files live in `vendor/disclose/`. This folder is only for rebuilding them.

## What it does

Every Orchard and Ironwood payment is encrypted with a fresh one-time secret, called the ephemeral secret key in the Zcash protocol. In Imani it is the payment's **opening key**. It is 32 bytes and opens that one payment, never another.

| Function | Takes | Gives back |
|---|---|---|
| `discloseOutputs(txHex, ufvk)` | A raw transaction and a viewing key | Every Orchard and Ironwood payment the key can see in it, each with its opening key (`eskHex`) |
| `openOutput(txHex, pool, index, receiverHex, eskHex)` | A raw transaction, which payment (`"orchard"` or `"ironwood"`, and its position), the 43-byte receiver it should have been paid to, and its opening key | The payment's amount, memo and receiver. Throws if it does not open |
| `orchardAddress(receiverHex, network)` | A 43-byte Orchard receiver | A unified address holding only that receiver |

Who can work out a payment's opening key: the receiver, with their viewing key (for a bid, the lot owner), and the sender, if their wallet kept a copy of what it sent under its outgoing viewing key.

`openOutput` calls `zcash_note_encryption::try_output_recovery_with_pkd_esk`. That function decrypts the payment with the opening key and the receiver, then refuses the result unless three things fixed in the transaction agree with it: the note commitment (which binds the amount and the receiver), the ephemeral public key, and the opening key worked out again from the note itself. A wrong or made-up opening key, a wrong receiver or a changed amount never opens. The same idea is behind the payment disclosures described in ZIP 311.

Version 5 and 6 transactions only. Sapling payments are not covered.

## How the shipped files were built

| | |
|---|---|
| Date | 2026-10-27 |
| Machine | Windows 11 |
| Rust | 1.99.1, `x86_64-pc-windows-gnu` host, `wasm32-unknown-unknown` target |
| C compiler for the secp256k1 code inside the Zcash crates | `zig cc` 0.16.0, target `wasm32-freestanding` (the Linux build uses clang) |
| wasm-bindgen | 0.2.126, built from crates.io |
| Crates | `Cargo.lock` here: the same versions as `tools/decoder/Cargo.lock`, plus `zcash_note_encryption` 0.5.1 as a direct dependency |

`bash tools/disclose/build.sh` rebuilds them on Linux or macOS. A different machine or compiler gives different WebAssembly bytes with the same behaviour, and the tests in `test/bid-proof.test.ts` are the real check. `vendor/disclose/SHA256SUMS` lists the shipped files, and `test/vendor.test.ts` checks them.

## Licence

MIT, like the rest of imani. The Zcash crates it builds on are MIT OR Apache-2.0; see `THIRD_PARTY.md`.
