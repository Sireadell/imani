# imani login, version 1

Sign in with a private Zcash wallet. A website shows a one-time code, the user sends a tiny shielded payment to the site with a signed login message in the memo, and the site reads that memo with its own read-only viewing key. The user's account is a login key the user holds, not a wallet address.

imani login is not a wallet. It never holds money, never asks for a seed phrase or spending key, and never asks the user for their viewing key.

Status: proposal, implemented in `src/login/`. Test vectors: `docs/login/vectors.json`. Setup guide: `docs/login/README.md`.

Servers contacted: none. Every function works on data the caller passes in. The site supplies the raw transaction bytes; fetching them from a light server is a later step and is not part of this version.

## 1. Prior art

Memo-challenge login on Zcash is not new. This design builds on ideas from SIWZ (AustinChris1/SIWZ), ZcashMe (zcashme/zns-login), Portal (IamHarrie-Labs/portal) and ZecAuth (raycre8-g/zecauth). No code was copied from any of them.

## 2. Parties and keys

| Item | Who holds it | Used for |
|---|---|---|
| Login key (32 random bytes) | The user, on their device | Making a separate signing key for each site |
| Site key | Derived on the user's device: Ed25519 seed = HMAC-SHA256(login key, `"imani login site key v1\n" + siteId`) | Signing login memos for that one site |
| Account id | The site, as the user's id | The site key's public key, 32 bytes, base64url without padding (43 characters) |
| Site address | Public | The site's own shielded or unified address, ideally used only for logins |
| Site viewing key | The site only | A unified full viewing key (`uview1...` or `uviewtest1...`) for that address. Read-only: it can show payments to the site, never spend them |

Two sites see two unrelated account ids for the same user, so they cannot link that user by comparing ids.

## 3. Flow

1. The site makes a challenge: a random code, its site id, its address, the network, an expiry time and a minimum amount. It stores the code.
2. The user's device builds the login memo (section 4) with the login key and turns it into a payment link (section 5).
3. The user's wallet opens the link and sends the payment. The memo is encrypted on chain; only the site's viewing key (and the sender's own wallet) can read it.
4. The user's page sends the site the transaction and a login proof (section 4a). The proof never goes into the payment link, the QR code or the payment.
5. The site reads the transaction with its viewing key and runs the checks in section 6. On success it uses up the code and starts a session for the account id.

Optional but recommended: in step 1 the page tells the site its account id (the public half of its site key) and the site reserves the code for it. Then only that key can use the code.

## 4. Login memo format

Plain UTF-8 text, lines separated by a single `\n`, no spaces, in this exact order:

```
imani-login:1
site:<siteId>
net:<main|test>
code:<nonce>
exp:<expiresAt>
key:<accountId>
sig:<signature>
```

| Field | Rule |
|---|---|
| `imani-login:1` | Format tag. A future format uses a new number; a parser refuses numbers it does not know |
| `site` | Lower-case host name with an optional port, 1 to 100 characters, for example `shop.example` or `localhost:3000` |
| `net` | `main` or `test` |
| `code` | 20 symbols from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I or L) in five groups of four joined by `-`, about 99 bits of randomness |
| `exp` | Expiry, Unix time in seconds, no leading zero |
| `key` | Account id, base64url without padding, 43 characters |
| `sig` | Ed25519 signature, base64url without padding, 86 characters |

The signature covers the memo text before `\nsig:`, that is the tag, site id, network, code, expiry and account id. A typical memo is about 220 bytes, well under the 512-byte memo limit. Trailing zero bytes (memo padding) are ignored. The builder refuses to write anything shaped like a Zcash viewing or spending key into a memo.

## 4a. Login proof

The memo is signed, but it is also in the payment link, so anyone who sees the link or QR holds a complete, validly signed memo. A signed memo alone therefore proves nothing about who is logging in. The proof closes that gap.

```
imani-login-proof:1
site:<siteId>
code:<nonce>
```

The proof is the Ed25519 signature of that text (lines joined by a single `\n`, no trailing newline) by the same site key, base64url without padding, 86 characters. It uses a different tag from the memo so one signature can never pass for the other. The user's page sends it to the site next to the transaction (Express: `{"txHex": "...", "proof": "..."}`). It is never put in the memo, the link or the payment. The site accepts a login only if the proof verifies against the account id inside the memo, so a front-runner without the account key cannot complete the login: they can pay the copied memo, but the site refuses it.

Reserving the code: the page may ask for the code with its account id (Express: `POST {base}/challenge` with `{"accountId": "..."}`). The site stores the id with the code and refuses any other key for it with `wrong_account`. Without this, a code is open to any key.

## 5. Payment link (ZIP 321)

The link is `zcash:<site address>?amount=<ZEC>&memo=<base64url memo>`. It follows ZIP 321, Payment Request URIs (https://zips.z.cash/zip-0321), which we read on 2026-10-07:

| ZIP 321 rule | How the link follows it |
|---|---|
| Amount is decimal ZEC: `1*DIGIT [ "." 1*8DIGIT ]`, at most 8 fraction digits, both sides of the point non-empty, at most 21,000,000 ZEC | `formatZec` writes zatoshis as decimal ZEC with no trailing zeros, for example 10,000 zatoshis is `0.0001` |
| Memo is "base64url without = padding" and the decoded memo "MUST NOT exceed 512 bytes" | The memo is base64url without padding, and the builder refuses anything over 512 bytes |
| A memo with a transparent address makes the whole URI invalid | The challenge only accepts unified or Sapling addresses |
| "There MUST NOT be more than one occurrence of a given parameter and paramindex" | Each parameter appears once |
| Parameters sharing a paramindex form one payment; other indexes are further payments | The login link has no indexed parameters: it always pays exactly one address |
| Unknown `req-` parameters make the URI invalid | The link has none, and `checkSinglePayee` refuses any |

`checkSinglePayee(uri)` refuses a link that pays more than one address. An open wallet issue (zodl-inc/zodl-android #2217) reports that a wallet showed only the first payee of a multi-payment link.

The link carries the signed memo, because that is how the wallet gets it. It is built on the user's side and handed to the wallet by QR code or tap. It is never a web address the site sees. It does not carry the login proof (section 4a), so seeing the link is not enough to log in.

## 6. Site checks, in order

| Step | Check | Failure name |
|---|---|---|
| 1 | Viewing key starts with `uview1` (main) or `uviewtest1` (test) | `bad_viewing_key` |
| 2 | Transaction bytes are hex and the decoder reads them | `unreadable_transaction` |
| 3 | At least one incoming output to the site | `nothing_for_this_site` |
| 4 | Exactly one incoming output whose memo starts with the tag | `no_login_memo`, `several_login_memos` |
| 5 | Memo parses (size, tag, then fields) | `memo_too_long`, `not_a_login_memo`, `memo_malformed` |
| 6 | Memo site id equals this site's id | `wrong_site` |
| 7 | Memo network equals the viewing key's network | `wrong_network` |
| 8 | Now is not later than the memo's expiry | `code_expired` |
| 9 | Signature verifies with the memo's account id | `bad_signature` |
| 10 | The login proof verifies with the memo's account id, for this site and code | `bad_proof` |
| 11 | This transaction id was never seen before (recorded now, after the proof passed) | `transaction_already_used` |
| 12 | The site issued this code | `unknown_code` |
| 13 | The code is unused | `code_already_used` |
| 14 | If the code was reserved for an account id, the memo's account id is that one | `wrong_account` |
| 15 | The code's site, network and expiry match the memo | `wrong_site`, `wrong_network`, `code_mismatch` |
| 16 | The code's expiry has not passed | `code_expired` |
| 17 | The code was issued for this site's address | `wrong_address` |
| 18 | The amount on the memo's output is at least the code's minimum | `amount_too_low` |
| 19 | Mark the code used, atomically; only one caller can win | `code_already_used` |

Steps 5 to 9 need no transaction and no store. They are what `docs/login/vectors.json` tests, so another implementation can check itself against ours.

A refused attempt never uses up the code, and nothing is recorded until the proof has passed. Transaction bytes are public once a payment is on chain, so a stranger can hand the site someone else's payment; without the matching proof it is refused and does not burn the payment or the code, and the real user can still log in. The proof is in the same request as the transaction, so the page that holds the key is the page that gets the session.

## 7. Stores and sessions

The code store is an interface with four methods: `put`, `get`, `consume` and `markTransactionUsed`. `consume` and `markTransactionUsed` must be atomic. The default `MemoryChallengeStore` keeps everything in one process; each instance is separate and the library has no global state. A site with several servers puts a database or shared cache behind the same interface.

Sessions come in two small forms: `SignedSessions` (a cookie value `s1.<payload>.<HMAC-SHA256>` whose payload holds only the account id and expiry) and `MemorySessions` (a random session id). Both are behind one `SessionIssuer` interface.

## 8. What the site learns

| The site learns | The site does not learn |
|---|---|
| The account id for this site | The wallet's address (shielded payments do not show the sender) |
| The amount of the login payment and its pool | The wallet's balance or history |
| The time of the login | The user's account id on any other site |

The leak test (`test/login/leak.test.ts`) runs the whole login, good and bad paths and both add-ons, and checks that the login key, the memo and the site's viewing key appear in no log line, error message, web response, cookie, session value or web address.

## 9. Honest limits

- **What a login proves.** It proves that someone who holds this login key, and who can spend shielded ZEC, sent the payment. It does not prove control of one specific wallet, and it does not say who the person is.
- **Lost key, lost account.** There is no recovery service and no cloud copy. `exportAccountKey` gives the user one line of text to keep as a backup, with a warning; `importAccountKey` reads it back. Anyone holding that text can sign in as the user.
- **A copied link no longer logs anyone in (fixed).** Before the login proof existed, someone who saw the payment link or QR could pay the copied memo from their own wallet, hand the transaction to the site, and be logged in as the victim. Now the site needs the proof, which only the account key can make and which is never in the link. See `test/login/frontrun.test.ts`.
- **Anyone who knows an unreserved code can use it up first.** The code is public on the page. With an unreserved code, anyone who sees it can pay it first with their own key, get their own account (not the victim's) and use the code up, so the victim's payment is refused and they must ask for a new code. That is a nuisance, not a break-in. Reserving the code for the page's account id (section 4a) removes it: another key gets `wrong_account` and the code stays open for the real user. Rate-limit the code route, because anyone can ask a site for as many codes as they like.
- **The page that holds the key is trusted.** If an attacker runs code inside the user's page or on their device, they can make the proof. The proof stops people who only see the screen, not people who control it.
- **Live relay is not stopped.** A fake site can show the real site's code and ask the user to pay it. The memo names the real site, and wallets that show the memo let the user notice, but nothing in the protocol stops a user who pays anyway.
- **It costs a payment and a wait.** The user pays the minimum (default 0.0001 ZEC) plus the network fee, and the site must wait for the transaction to reach it.
- **The site's viewing key cannot be revoked.** A Zcash core developer has said that shared viewing key access cannot be taken back. Use a separate address and key only for logins, and never share it.
- **Not checked against a real wallet yet.** The tests use real transaction bytes built offline by the librustzcash builder on the test network. A login from a real wallet on mainnet is a later step.

## 10. Test vectors

`docs/login/vectors.json` is generated from fixed seeds by `test/login/conformance-vectors.ts` and checked by `test/login/conformance.test.ts`. It has four parts:

| Part | Content |
|---|---|
| `derive` | Login key bytes and site id, with the expected account id |
| `build` | Login key, challenge, the exact signed text, memo, memo length and payment link (Ed25519 signatures are deterministic, so these match byte for byte) |
| `memoCheck` | 24 memos checked against site `shop.example`, network `test`, time 1790000000: 3 valid, 21 invalid, each with its failure name |
| `singlePayee` | Payment links and whether each pays exactly one address |

All keys in the vectors are throwaway test values.
