# Adding imani login to a site

The full design, checks and limits are in [LOGIN_SPEC.md](../../LOGIN_SPEC.md). Servers contacted: none. In this version your server passes in the raw transaction; fetching it from a light server comes later.

The package is not on npm yet. Until it is, import from `src/login/index.ts` in this repo where the examples say `"imani/login"`.

You need: a shielded or unified address used only for logins, and its read-only unified full viewing key (`uview1...`). Never give the kit a seed phrase or spending key; it refuses them.

## Express (5 lines)

Express is not a dependency of imani; use the one your app already has.

```ts
import { LoginKit, SignedSessions, zcashLogin, requireZcashLogin } from "imani/login";
const kit = new LoginKit({ siteId: "shop.example", siteAddress: process.env.LOGIN_ADDRESS!, viewingKey: process.env.LOGIN_UFVK! });
app.use(express.json({ limit: "1mb" }));
app.use(zcashLogin({ kit, sessions: new SignedSessions(process.env.SESSION_SECRET!) }));
app.get("/account", requireZcashLogin, (req, res) => res.json({ account: req.zcashAccount }));
```

This adds `GET /zcash-login/challenge`, `POST /zcash-login/verify` (body `{"txHex": "..."}`, sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie) and `POST /zcash-login/logout`. On every other request `req.zcashAccount` holds the signed-in account id.

## Auth.js / NextAuth (5 lines plus imports)

Auth.js is not a dependency of imani either. The kit returns the settings for Auth.js's own Credentials provider.

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { LoginKit, zcashCredentials } from "imani/login";
const kit = new LoginKit({ siteId: "shop.example", siteAddress: process.env.LOGIN_ADDRESS!, viewingKey: process.env.LOGIN_UFVK! });
export const { handlers, auth, signIn } = NextAuth({ providers: [Credentials(zcashCredentials(kit))] });
// app/api/zcash-login/challenge/route.ts:  export const GET = zcashChallengeRoute(kit);
```

Sign in with `signIn("zcash", { txHex })`. The session's user id is the account id. The kit object must be shared between the challenge route and the provider (one module), so both use the same code store.

## On the user's side

```ts
import { AccountKey, buildLoginMemo, buildPaymentUri, exportAccountKey, importAccountKey, EXPORT_WARNING } from "imani/login";
const key = AccountKey.generate();                    // once; keep exportAccountKey(key) as the backup, show EXPORT_WARNING
const challenge = await (await fetch("/zcash-login/challenge")).json();
const uri = buildPaymentUri(challenge, buildLoginMemo(key, challenge)); // show as a QR code or link for the wallet
```

The login key never leaves the device and never goes into a web address. The payment link carries the signed memo, because that is how the wallet receives it.

## Using your own store

Put a database behind the `ChallengeStore` interface (`put`, `get`, `consume`, `markTransactionUsed`) and pass it as `store` to `LoginKit`. `consume` and `markTransactionUsed` must succeed for exactly one caller, for example an `UPDATE ... WHERE used = false` that reports one changed row.

## Tests

```sh
npm run test:login
```

| File | What it shows |
|---|---|
| `test/login/core.test.ts` | Codes, memo format, payment link, every refusal by name, racing logins, separate stores, backup export |
| `test/login/offline.test.ts` | Real transaction bytes: wallet A logs in, wallet B (different address) lands in the same account, Orchard and Ironwood both work, replays and wrong-site payments fail |
| `test/login/adapters.test.ts` | Express middleware and Auth.js provider settings, driven with real transactions |
| `test/login/leak.test.ts` | Login key, memo and viewing key never appear in logs, errors, responses, cookies, sessions or web addresses |
| `test/login/conformance.test.ts` | Checks `docs/login/vectors.json` and that it regenerates byte for byte |

## Rebuilding the test data

Conformance vectors (Node only):

```sh
npx tsx test/login/conformance-vectors.ts --write
```

Offline login transactions (Rust, in a zcash-devtool checkout at commit `5a26ee8`, same setup as `tools/gen-vectors/README.md`):

```sh
npx tsx test/login/make-offline-inputs.ts          # writes test/login/vectors/login-inputs.json
cp tools/gen-vectors/gen_login.rs <zcash-devtool>/examples/
cd <zcash-devtool>
cargo run --release --example gen_login -- parties   # site and wallet addresses (fixed seeds)
cargo run --release --example gen_login -- build login-inputs.json login-offline.json
cp login-offline.json <imani>/test/login/vectors/
```

Every key is a throwaway test value, every funding coin is invented, and nothing is broadcast.
