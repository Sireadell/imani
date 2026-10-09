# Judge guide

Imani checks that a sealed-bid auction on Zcash was fair, and lets people sign in with a private Zcash wallet. This page shows you how to try it in two minutes and how to test our privacy claim yourself.

If a seller of something on Zcash runs a sealed auction, the bidders have to take the seller's word that the winner and price are right. Imani lets anyone recompute the result from the chain, using a read-only key the seller shares after the close. It answers PASS or FAIL, and names the check that failed.

Everything below runs on fake test-network payments built with throwaway keys. Nothing here uses real money.

## Try it in two minutes

You need Node 22.18 or newer. In this folder:

```sh
npm install
npm run demo
```

You will see three checks of the same small auction. The honest round ends with `RESULT: PASS`. A copy where the seller refunded one loser 100,000 zatoshis too little ends with `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. A copy where the seller left a 3,000,000 bid out of their files ends with `RESULT: FAIL (1 of 20 checks failed: scan-hidden-bids)`. It takes about two seconds and needs no internet.

Prefer a page? Run `npm run site:serve` and open http://localhost:8788. It opens on the honest round. Press "Try a tampered copy" to see each of the 6 broken copies fail on the check built to catch it. The memo examples add two more. Paste a bid's transaction id into "Was my bid counted?" to see what a bidder would see.

Prefer to see the whole shop? Run `npm run demo:app` and open http://localhost:8787. It is a small auction shop where you sign in with a private wallet, place a bid, skip to the close, and check the result (8 broken copies there). A yellow banner says it is simulated, because the payments go to a pretend network.

## What to look at for each score line

| You score | Where to look | What you will find |
|---|---|---|
| Privacy | The browser page's network tab | No request after the page loads. The page's security policy forbids network calls (`connect-src 'none'`), and the page prints "Servers contacted: none". |
| Privacy | `npm run leak-scan` | Fails if any tracked file holds something shaped like a viewing key, spending key or seed phrase. CI runs it. |
| Privacy | `imani check ... --offline` | Opens no connection at all. Every run prints the exact list of servers it contacted. |
| Privacy | The sign-in receipt (shop page after signing in, and the Next.js example's account page) | Lists what the site stored for your account, read from its real storage, and counts how often secrets (your account key, your login memo, the site's viewing key and session secret) appear in it: 0 each. A planted leak is caught in `test/login/receipt.test.ts`. |
| Privacy | The checker's keys | It refuses spending keys and seed phrases, and never prints or saves the key it is given. |
| Usefulness | `imani check --mine <your bid's transaction id>` | A bidder learns whether their bid was counted, whether it won, what should come back, and whether the refund reached the address they chose. |
| Execution | `npm test` | 77 tests. One of them installs the packed package in an empty folder and runs a check, inside 120 seconds. |
| Originality | The bid memo | Bidders write their own refund address at the end of their bid memo, so a seller cannot swap it. The checker reads it from the chain. |

## The three things the checker can catch that a plain list cannot

| Cheat | How it is caught |
|---|---|
| The seller refunds a loser less than they paid, or refunds the wrong person | The key shows each refund's amount, memo and receiver, and the checker compares them with what the rules owe |
| The seller leaves a bid out of their files | The scan reads every block of the auction and finds the payment the seller did not list |
| The seller changes the rules or the winners after the close | The checker works out the winners and the price again from the chain and compares |

The six broken copies in `examples/broken/` each fail on exactly one named check. They are listed with a plain reason in `examples/broken/manifest.json`.

## What this does not do

| Limit | What it means |
|---|---|
| It only works when the seller shares the lot's read-only key | Without the key only the basic checks run. A seller who never shares a key cannot be checked. |
| The seller can see bids as they arrive | The checker proves the counting, amounts, price and refunds are right. It does not prove the seller never looked. |
| It is not a zero-knowledge proof | You recompute the result yourself from data the seller chose to share. |
| A shared viewing key cannot be taken back | Each lot uses its own fresh key, so sharing one only exposes that lot. |
| The refund address in a bid memo is public after the close | Use a fresh address for each auction. |
| The login proves "someone holding the account key who can spend shielded ZEC" | It does not prove control of one specific wallet. |
| Our round is our own | Every example is made-up test data, so it shows the mechanism and not a real seller. |

## Where the code is

| Part | Folder |
|---|---|
| The checker | `src/check.ts`, `src/scan/` |
| The reader of Zcash payments (prebuilt, source in `tools/decoder/`) | `vendor/decoder/` |
| The browser page | `src/site/` |
| The shop demo | `demo/` |
| The login kit | `src/login/` |
| What each file in an auction must hold | `SPEC.md`, `LOGIN_SPEC.md` |
| Licences and credits | `LICENSE`, `THIRD_PARTY.md` |
