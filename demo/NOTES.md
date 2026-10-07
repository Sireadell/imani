# Demo app notes

## Things found in shared code (not changed here)

- `src/fetch/index.ts` uses a TypeScript constructor parameter property (`public readonly` in `FetchError`). Plain `node` with type stripping cannot load that, so the demo runs through `tsx` (`npm run demo:app`) instead of `node` directly.
- On 2026-10-07, with the decoder rebuild in progress in the working tree, `test/read.test.ts` "reads amounts from a viewing key alone" failed (3 outputs seen, 2 expected). The demo's own tests and the auction check still pass. Recheck when the decoder rebuild is committed.

## Choices

- No QR code. A correct QR encoder needs its own decoder to test against, and no library was added. The page shows the payment link and an "Open in my wallet" button.
- Simulated bids replay bid 2 of `examples/round-01`, because only real transaction bytes can be read with the lot key.
- Simulated sign-in payments are kept by `demo/chain.ts` and read through `LoginKit.verify` with a swapped reader. Live mode uses the same call with the real decoder and bytes from `src/fetch`.
