# real-login: a sign-in with a real wallet on the Zcash test network

On 2026-10-19 a real wallet (zecd 0.9.0-rc1) paid a site address on the public Zcash test network, with a login memo made by this repo's login kit. The wallet and the site address were made for this test and have been deleted. The coins came from a public faucet and have no value.

The payment: [41e66fe9dc74e1f5dde57a653157bc5b571bea096fd5ca0e85f66387bc5b74c9](https://testnet.zecblock.com/tx/41e66fe9dc74e1f5dde57a653157bc5b571bea096fd5ca0e85f66387bc5b74c9), block 4,518,308, 10,000 zatoshis into the Ironwood pool. The explorer shows that it exists and its block. The memo and amount are private and only show with the site's viewing key.

`round.json` holds the exact transaction bytes, the site's read-only viewing key, the one-time code and the login proof. `test/login/real-wallet.test.ts` replays it offline: the login works, the same payment cannot log in twice, a stranger without the proof cannot log in, and an expired code or a different site is refused.

```sh
npx tsx --test test/login/real-wallet.test.ts
```
