# Third-party code and data

| Item | Use | Licence |
|---|---|---|
| librustzcash crates: [zcash_client_backend](https://crates.io/crates/zcash_client_backend) 0.24.0, [zcash_primitives](https://crates.io/crates/zcash_primitives) 0.30.1, [zcash_keys](https://crates.io/crates/zcash_keys) 0.16.1, [zcash_protocol](https://crates.io/crates/zcash_protocol) 0.10.5, [zcash_transparent](https://crates.io/crates/zcash_transparent), [zcash_note_encryption](https://crates.io/crates/zcash_note_encryption), [orchard](https://crates.io/crates/orchard) 0.15.3, [sapling-crypto](https://crates.io/crates/sapling-crypto) 0.7.0, and their dependencies | Compiled into the transaction decoder in `vendor/decoder/` (source in `tools/decoder/`), which reads shielded outputs with a viewing key | MIT OR Apache-2.0 |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) and js-sys | Generated JavaScript glue in `vendor/decoder/imani_decoder.js` | MIT OR Apache-2.0 |
| [zcash-devtool](https://github.com/zcash/zcash-devtool) commit `5a26ee8` | Its `Cargo.lock` fixes the crate versions used by `tools/decoder` and `tools/gen-vectors`; its build setup and transaction builder make the offline test transactions in `test/vectors/offline-vectors.json`; no code copied | MIT OR Apache-2.0 |
| LedgerHQ/zcash-decrypt test case `decrypts_sapling_transaction` | One testnet transaction and viewing key kept in `test/vectors/ledger-testnet-orchard-internal.json` as a reader sanity test. The `@ledgerhq/zcash-decrypt` package itself is no longer used | MIT AND Apache-2.0 |

No code is copied from other hackathon entries. All imani code was written during the Zecathon build window.
