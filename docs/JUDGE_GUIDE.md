# Judge guide

Imani is a Zcash tool: a TypeScript library and a command line that read shielded payments with librustzcash (compiled to WebAssembly, so it runs in Node and in a browser), check a whole round from one read-only viewing key plus public chain data, and can download every block from two independent block servers that must agree. Its job today is checking that a sealed-bid auction on Zcash was run fairly. A smaller second tool lets people sign in to a website by paying from a private Zcash wallet. The short version, one command per judging line, is at the top of the [README](../README.md). This page shows you how to try it in two minutes and how to test our privacy claim yourself.

If a seller of something on Zcash runs a sealed auction, the bidders have to take the seller's word that the winner and price are right. Imani lets anyone recompute the result from the chain, using a read-only key the seller shares after the close. It answers PASS or FAIL, and names the check that failed.

The checker page opens on a real auction: a real wallet paid its bids and refunds into the Ironwood pool on the public Zcash test network (test coins, no money). Its lot name, `DRY-01`, stands for dry run: a real round paid with test coins before any real money. The other examples are made-up rounds built with throwaway keys.

## Try it in two minutes

You need Node 22.18 or newer. In this folder:

```sh
npm install
npm run demo
```

You will see three checks of the same small auction. The honest round ends with `RESULT: PASS`. A copy where the seller refunded one loser 100,000 zatoshis too little ends with `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. A copy where the seller left a 3,000,000 bid out of their files ends with `RESULT: FAIL (1 of 20 checks failed: scan-hidden-bids)`. It takes about two seconds and needs no internet.

Prefer a page? Open https://imani-check.vercel.app, or run `npm run site:serve` and open http://localhost:8788 for the same page built from your own copy. It opens on the real test-network round (PASS, 21 of 21). Press "The seller hides a bid" to see the scan catch it, or "Try a tampered copy" for the 6 made-up broken copies. The memo examples add two more. Paste a bid's transaction id into "Was my bid counted?" to see what a bidder would see.

Prefer to see the whole shop? Run `npm run demo:app` and open the address it prints (usually http://localhost:8787, a free port if that one is taken). It is a small auction shop where you sign in by paying from a private wallet, place a bid, skip to the close, and check the result (8 broken copies there). A yellow banner says it is simulated, because the payments go to a pretend network.

## What to look at for each score line

| You score | Where to look | What you will find |
|---|---|---|
| Privacy | The checker page's network tab (https://imani-check.vercel.app) | No request after the page loads. The page's security policy forbids network calls (`connect-src 'none'`), and the page prints "Servers contacted: none". |
| Privacy | The "Check any round" page's network tab (`check.html`) | This page does use the network, and says so before it does. Nothing is sent until you press the button that names the servers. Then it sends one request per block to our site, with only the network and the block number. Our site fetches each block from two public Zcash servers (on the test network, testnet.zec.rocks and CipherScan). They learn which block numbers were asked for, and our site also sees your IP address. Your viewing key stays in the tab. A saved block file, or `imani check --offline`, sends nothing. In short: our server (`/api/block`) sees block numbers only, never a key. It is there because public block servers do not let a web page ask them directly. To skip it, run `node tools/referee-serve.ts` and open the page from your own computer (it asks the two public servers itself), or go fully offline with "Pick a block file" on the page or `imani check --disclosure <file> --result <file> --scan --chain <block file>`. |
| Privacy | `npm run leak-scan` and `npm run leak-scan:history` | Fails if any tracked file, or any file in any commit of the history, holds something shaped like a viewing key, spending key or seed phrase. CI runs both. |
| Privacy | `npx imani linking examples/testnet-01/disclosure.json` | How far a refund can be followed by anyone with the lot key. Inside the round each refund names its bid on purpose. Links that reach outside it (one receiver paid for two bids, or the same receiver in two rounds): 0 in the real round. Give it `examples/memo-01/disclosure.json examples/receivers-01/disclosure.json` to see 4 bidders followed from one round to the other. |
| Privacy | `docs/WHO_LEARNS_WHAT.md`, and the same table on the page | What an onlooker, anyone with the published key, the seller, each bidder, the hosts of both pages and the public servers can learn in the real round, worked out from its files by `npm run who-learns`. A test fails if the table drifts from the code. |
| Privacy | `imani check ... --offline` | Opens no connection at all. Every run prints the exact list of servers it contacted. |
| Privacy | The sign-in receipt (shop page after signing in, and the Next.js example's account page) | Lists what the site stored for your account, read from its real storage, and counts how often secrets (your account key, your login memo, the site's viewing key and session secret) appear in it: 0 each. A planted leak is caught in `test/login/receipt.test.ts`. |
| Privacy | `npx imani bid-proof check --proof examples/bid-proof-01/proof.json --facts examples/bid-proof-01/lot-public.json --result examples/testnet-01/result.json --fetch` | Proves one real bid (3,000,000 zatoshis in the test-network round) to someone who holds no viewing key: `RESULT: PASS (9 of 9 lines proven)`. The file carries only that payment's opening key, so the round's other two bids and three refunds stay closed. It proves a payment, not who paid it, and so far only the lot owner has made one on a real round. Sealed lots, Sapling and top-ups are not covered. Offline: `--chain examples/testnet-01/chain.json` instead of `--fetch`. Details: `docs/BID_PROOF.md`. |
| Privacy | The checker's keys | It refuses spending keys and seed phrases, and never prints or saves the key it is given. |
| Usefulness | `imani check --mine <your bid's transaction id>` | A bidder learns whether their bid was counted, whether it won, what should come back, and whether the refund reached the address they chose. |
| Usefulness | https://imani-check.vercel.app/check.html ("Check any round") | Paste the viewing key and block range of any sealed-bid round, ours or not, and get PASS or FAIL from the chain alone, with no seller file. Nothing is sent until you press the button that names the servers. The site then fetches each block from two public Zcash servers run by different operators, and the key stays in your tab. If they cannot be reached, "Use the saved copy" or a saved block file runs the same check with no network at all. Our real round: PASS live in about a minute, or about 3 seconds from the saved copy. |
| Execution | `npm run test:all` (about nine minutes) | <!--count:total-->1610<!--/count--> tests across the checker, the login kit, the shop, the reader for rounds others ran, the browser page, the scan, the downloader and the privacy measures (`npm test` runs the first <!--count:test-->225<!--/count-->), including <!--count:test:tamper-->1127<!--/count--> that change one fact at a time in every example round and require that none of them passes, plus <!--count:skipped-->3<!--/count--> live tests that read from public servers when `LIVE=1` is set. One of them installs the packed package in an empty folder and runs a check, inside 120 seconds. GitHub runs all of them on Windows and Linux. The run checks the counts on this page and fails if they drift. Group by group: `docs/HOW_WE_TESTED.md`. |
| Usefulness | `npm run build`, then `node examples/library/catch-a-hidden-bid.mjs` | The every-block scan run from code instead of the command line, the way a wallet or app would use it. Prints `testnet-01: PASS (21 of 21 checks passed)`, then a copy where the seller hid a bid failing on `scan-hidden-bids`. Add `--fetch` to download the real round's blocks live. Every function: `docs/LIBRARY.md`. |
| Usefulness | `imani settle --folder <lot folder> --fetch`, right after the close | A seller does not have to wait for the refund deadline to see what to pay. It reads up to the newest block, lists each refund owed with its address and memo, and says which blocks are still to come, so it cannot pass early. Tested against two stand-in servers: `npx tsx --test test/settle-early.test.ts`. Steps: `docs/SELLER_KIT.md`. |
| Usefulness | `npm run check:external -- test/external/round-files/demo01-settlement.json` | Recomputes a round we did not run: a real round another Zcash auction project published, from its own files and under its own pricing rule. It reads only the numbers in the file and opens no connection. Their tampered demo file fails here on a refund that does not match its bid. Details and limits: `docs/EXTERNAL_ROUNDS.md`. |
| Execution | `npm run check:external -- test/external/round-files/demo01-settlement.json --fetch` | Ties that same round, which ran on Zcash mainnet, to the chain. It asks two independent public servers for its 3 listed payments, and each must return the same bytes, which must hash to the listed id. Expect `Blocks: 3499413, 3499451.` and `RESULT: PASS`. It cannot read the amounts, because that round's viewing key was never published. With no internet, use `--chain test/external/round-files/demo01-chain.json` instead of `--fetch` to read a saved copy, which prints `Servers contacted: none (read from a saved copy of an earlier fetch).` Code: `src/external/anchor.ts`. |
| Execution | `npm run conformance -- --cmd "node bin/imani.js check"` (about 40 seconds) | Grades a checker against 52 rounds with known answers, using the file format in `docs/FORMAT.md` and the schemas in `schema/`. Expect `Conformance: FULL (52 of 52 verdicts right, 42 of 42 broken copies named correctly)`. Put any other checker's command after `--cmd` to grade it the same way. |
| Usefulness | `npx tsx --test test/login/real-wallet.test.ts` | Sign-in with a real wallet: one payment mined on the public Zcash test network (transaction id and explorer link in `examples/real-login/README.md`) logs in, replays offline, and a second use, a missing proof, an expired code and a different site are all refused. |
| Usefulness | `npm run login:scorecard` | Six checks any memo-based login can be pointed at (one-time code, expiry, new wallet address, secrets in the link, sender hidden, copycat). Our login passes 6 of 6, a weak example we wrote passes 1 of 6. How to score another login: `docs/login/SCORECARD.md`. |
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
| The seller can see bids as they arrive | Only in a plain lot. The checker proves the counting, amounts, price and refunds are right, and it does not prove the seller never looked. In a sealed lot the seller holds no prices until the close (bidders pay a fixed deposit with only a hash of their price, then open it), and the checker verifies every opening. Example: `examples/sealed-01` and its 8 broken copies, also on the live page. |
| It is not a zero-knowledge proof | You recompute the result yourself from data the seller chose to share. |
| A shared viewing key cannot be taken back | Each lot uses its own fresh key, so sharing one only exposes that lot. |
| The refund address in a bid memo is public after the close | Use a fresh address for each auction. `imani linking` shows when an address was reused. |
| The login proves "someone holding the account key who can spend shielded ZEC" | It does not prove control of one specific wallet. |
| Our rounds are our own | The real round was paid by our own wallet on the test network and the rest are made-up, so they show the mechanism and not a real seller. |

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
