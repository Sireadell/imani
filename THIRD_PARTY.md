# Third-party code and data

| Item | Use | Licence |
|---|---|---|
| [@ledgerhq/zcash-decrypt](https://github.com/LedgerHQ/zcash-decrypt) | Decrypts shielded Zcash transactions with a viewing key (prebuilt WebAssembly) | MIT AND Apache-2.0 |
| [zcash-devtool](https://github.com/zcash/zcash-devtool) and its librustzcash crates (zcash_primitives, orchard, zcash_keys, zcash_protocol, zcash_transparent, zcash_proofs, zcash_client_backend) | Build setup and transaction builder used by `tools/gen-vectors` to make the offline test transactions in `test/vectors/offline-vectors.json`; no code copied | MIT OR Apache-2.0 |
| LedgerHQ/zcash-decrypt test case `decrypts_sapling_transaction` | One testnet transaction and viewing key kept in `test/vectors/ledger-testnet-orchard-internal.json` as a reader sanity test | MIT AND Apache-2.0 |

No code is copied from other hackathon entries. All imani code was written during the Zecathon build window.
