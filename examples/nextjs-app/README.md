# Next.js app with Zcash sign-in

This is the [Next.js authentication example](https://github.com/vercel/next.js/tree/canary/examples/auth) (MIT, Vercel) with one change: the GitHub button is replaced by a private Zcash sign-in from imani. It shows the login kit working inside a real Next.js app with Auth.js, a signed-in page and a sign-out button.

It is simulated. There is no wallet and no network: a "pretend wallet" button sends the sign-in payment, so you can try the whole flow with no money. The public test address and key in `lib/sim-party.json` never held funds.

## Run it

From the repository root, build the package once:

```sh
npm install
npm run build
```

Then in this folder:

```sh
cd examples/nextjs-app
npm install
```

Copy `.env.example` to `.env.local` and put a random value in `AUTH_SECRET`. Then:

```sh
npm run dev
```

Open http://localhost:3000. Press "Make my account key", "Get a sign-in code", then "Pay from the pretend wallet". You land on `/account`, a page that redirects to the home page when you are signed out.

## What changed from the Next.js example

| File | Change |
|---|---|
| `auth.ts` | GitHub replaced by `Credentials(zcashCredentials(kit))` |
| `lib/kit.ts` | New. One `LoginKit` for the server, with the site's address and read-only viewing key |
| `app/api/zcash-login/challenge/route.ts` | New. Hands out one-time codes, reserved for the visitor's account id |
| `app/components/ZcashSignIn.tsx` | New. Makes the account key on the visitor's device, builds the payment link and the proof, and signs in |
| `lib/browser-login.js` | New. The browser side of the login (Web Crypto only), the same file the demo shop uses |
| `lib/sim-chain.ts`, `app/api/sim/pay/route.ts` | New. The pretend wallet and network. Delete both for a real site |
| `middleware.ts` | Removed. The account page checks the session itself |

## Use it on a real site

1. Make a throwaway address used only for logins, and copy its read-only unified full viewing key (`uview1...` or `uviewtest1...`). Never a spending key or a seed phrase: the kit refuses them.
2. Set `LOGIN_ADDRESS`, `LOGIN_UFVK` and `LOGIN_SITE_ID` (your domain) in the environment. With `LOGIN_UFVK` set, the kit stops using the pretend network.
3. Delete `lib/sim-chain.ts` and `app/api/sim/pay/route.ts`, and change `ZcashSignIn.tsx` to show the payment link as a QR code. After the wallet pays, fetch the transaction and pass its hex to `signIn("zcash", { txHex, proof })`.

`next.config.ts` has two lines for this repository only: `turbopack.root` so Next can read the linked package, and `serverExternalPackages` so Node loads the WebAssembly reader from its own folder. A site that installs imani from npm keeps only the second.

What the site learns, and the honest limits, are in [LOGIN_SPEC.md](../../LOGIN_SPEC.md) and [docs/login/README.md](../../docs/login/README.md).
