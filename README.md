# Imani

*Imani means "trust" in Swahili.*

## Try it in one minute

You need Node 22.18 or newer. In this folder:

```sh
npm install
npm run demo
```

You will see two checks of the same small auction. The first is the honest round and ends with `RESULT: PASS`. The second is a copy where the seller paid a losing bidder 100,000 zatoshis too little, and it ends with `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. It takes about a second and needs no internet.

To check a lot yourself:

```sh
npx imani check --disclosure examples/round-01/disclosure.json --result examples/round-01/result.json --out report
```

This prints every check and writes `report/verdict.json` and `report/report.html` (open it in any browser, it works offline). Add `--discreet` to hide amounts and memos, or `--basic` to run only the checks that need no key. Try the six broken copies in `examples/broken/`: each one fails on exactly one named check, listed in `examples/broken/manifest.json`.

## Where every number comes from

| Source | What it gives |
|---|---|
| The chain, read with the lot key | Bid amounts, bid memos, refund amounts, refund memos, transaction ids |
| The seller's result file | The bid list, winners, clearing price, reserve outcome and refund list the seller claims |
| The seller's disclosure file | Close height, block height of each transaction, item count and reserve |

The checker works the result out again from the chain numbers and compares it with the seller's file. The report shows each check with PASS or FAIL, a one-line reason, and which numbers came from where.

## What it is

Two small tools for private Zcash apps.

1. **Check a sealed-bid auction.** After an auction closes, the seller shares a one-time read-only key for that lot. imani reads the lot's private payments with that key, works out the bid count, amounts, winners, price and refunds again, and compares them to the seller's published result: PASS or FAIL.
2. **Sign in with a private Zcash wallet.** A login button any website can add. Your account is tied to a login key, so it survives a change of wallet address. (Not built yet.)

The file formats, price rule, every check and the known limits are in [SPEC.md](SPEC.md).

## Safety

The checker only accepts a read-only viewing key (starts with `uview1` or `uviewtest1`). It refuses seed phrases and spending keys, never prints the key and never saves it. If the key shows payments that are not bids for the lot, the check fails and tells the seller to use a fresh key for every lot. This version contacts no server at all and prints `Servers contacted: none`.

## Tests

```sh
npm test
npm run typecheck
```

The example round is made of fake test-network transactions built offline with throwaway keys (see `tools/gen-vectors/README.md`). `npm run examples` rebuilds the example files from them.

Status: early build for Zecathon, Core & Tooling track.

Licence: MIT. See THIRD_PARTY.md for the libraries used.
