# Imani

*Imani means "trust" in Swahili.*

## Try it in one minute

You need Node 22.18 or newer. In this folder:

```sh
npm install
npm run demo
```

You will see three checks of the same small auction. The first is the honest round and ends with `RESULT: PASS`. The second is a copy where the seller paid a losing bidder 100,000 zatoshis too little, and it ends with `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. In the third, the seller left a 3,000,000 bid out of their files entirely. The normal check cannot see it, because it only reads what the seller lists. The scan reads every block of the auction and ends with `RESULT: FAIL (1 of 20 checks failed: scan-hidden-bids)`. It takes about two seconds and needs no internet.

To check a lot yourself:

```sh
npx imani check --disclosure examples/round-01/disclosure.json --result examples/round-01/result.json --out report
```

This prints every check and writes `report/verdict.json` and `report/report.html` (open it in any browser, it works offline). Add `--discreet` to hide amounts, memos and addresses, `--offline` to make sure no connection is ever opened, or `--basic` to run only the checks that need no key. Nothing shaped like a key or seed phrase can be printed or written. `npm run leak-scan` checks every tracked file for keys, seed phrases and `.env` files (public test keys are listed with a reason in `tools/leak-scan.allow.json`), and CI runs it. Try the six broken copies in `examples/broken/`: each one fails on exactly one named check, listed in `examples/broken/manifest.json`.

To also read every block of the auction, so a bid the seller left out still shows up:

```sh
npx imani check --disclosure examples/scan-01/disclosure.json --result examples/scan-01/result.json --scan --chain examples/scan-01/chain.json
```

This reads the blocks from a saved file. Use `--fetch` instead of `--chain` to download them from public Zcash servers (slower: about an hour for a day-long auction, see SPEC.md). `examples/scan-broken/` has three copies that only the scan catches: a hidden bid, a listed payment that is not on the chain in time, and a wrong block height.

## Where every number comes from

| Source | What it gives |
|---|---|
| The chain, read with the lot key | Bid amounts, bid memos, refund amounts, refund memos, transaction ids |
| The seller's result file | The bid list, winners, clearing price, reserve outcome and refund list the seller claims |
| The seller's disclosure file | Close height, block height of each transaction, item count and reserve |
| Every block of the auction, with `--scan` | Any payment the seller left out, and the real block height of each listed one |

The checker works the result out again from the chain numbers and compares it with the seller's file. The report shows each check with PASS or FAIL, a one-line reason, and which numbers came from where.

## What it is

Two small tools for private Zcash apps.

1. **Check a sealed-bid auction.** After an auction closes, the seller shares a one-time read-only key for that lot. imani reads the lot's private payments with that key, works out the bid count, amounts, winners, price and refunds again, and compares them to the seller's published result: PASS or FAIL.
2. **Sign in with a private Zcash wallet.** A login button any website can add. Your account is tied to a login key, so it survives a change of wallet address. (Not built yet.)

The file formats, price rule, every check and the known limits are in [SPEC.md](SPEC.md).

## Safety

The checker only accepts a read-only viewing key (starts with `uview1` or `uviewtest1`). It refuses seed phrases and spending keys, never prints the key and never saves it. If the key shows payments that are not bids for the lot, the check fails and tells the seller to use a fresh key for every lot. By default it contacts no server and prints `Servers contacted: none`. Only `--scan --fetch` goes online; it asks for blocks by number, never sends a key, and prints every server it used.

## Honest limits: sign in with a private wallet

- Seeing someone's sign-in payment link or QR does not let you log in as them. The site also needs a proof that only their login key can make, and it is never in the link.
- If a sign-in code is not reserved for the user's key, anyone who sees the code can pay it first with their own key and use it up. They get their own account, not the victim's, but the real user must ask for a new code. Reserving the code for the user's key stops this.
- Anyone who controls the user's device or page can make the proof. It protects against people who only see the screen.

Full list: LOGIN_SPEC.md, section 9.

## Tests

```sh
npm test
npm run typecheck
```

The example round is made of fake test-network transactions built offline with throwaway keys (see `tools/gen-vectors/README.md`). `npm run examples` rebuilds the example files from them.

Status: early build for Zecathon, Core & Tooling track.

Licence: MIT. See THIRD_PARTY.md for the libraries used.
