# How we tested Imani

Every number on this page comes from a command you can run in this folder. The test counts are written by the test run itself: `npm run test:all` fails if any count here or in the judge guide no longer matches, so this page cannot drift from the code.

## The whole suite

```sh
npm ci
npm run test:all
```

<!--count:total-->1607<!--/count--> tests in <!--count:groups-->9<!--/count--> groups. On a normal run <!--count:pass-->1604<!--/count--> pass and <!--count:skipped-->3<!--/count--> are skipped: the two live tests below, which read from public servers only when you ask. Expect about nine minutes on a laptop. GitHub runs the same suite on every push, on Windows and on Linux (`.github/workflows/ci.yml`), after a type check and both leak scans.

<!-- test-groups:start -->
| Command | What it covers | Tests | Skipped |
|---|---|---|---|
| `npm run test` | The checker: reading payments with a viewing key, the auction rules, each check level, the bidder's own check, refusing spending keys, the packed package, the leak scanner | 222 | 0 |
| `npm run test:login` | Sign-in with a private wallet: one-time codes, expiry, replays, copied links, wrong sites, the receipt, a real test-network payment | 76 | 0 |
| `npm run test:fetch` | Downloading blocks from two public servers and checking they agree | 35 | 2 (live, needs `LIVE=1`) |
| `npm run test:demo` | The auction shop demo, from sign-in to the checked result | 11 | 0 |
| `npm run test:scan` | The scan that reads every block of an auction to find bids the seller left out | 32 | 1 (live, needs `LIVE=1`) |
| `npm run test:site` | The browser page and the page that checks any round: same answers as the command line, no network call until the reader says yes, and a saved-file check with none | 77 | 0 |
| `npm run test:tamper` | Change one fact at a time in every example round; none of the changed copies may pass | 1127 | 0 |
| `npm run test:external` | Rounds another auction project published, read from their own files | 16 | 0 |
| `npm run test:privacy` | Refund linking, the who-learns-what table, keys never printed or saved | 11 | 0 |
<!-- test-groups:end -->

## Changing one fact at a time

`npm run test:tamper` runs <!--count:test:tamper-->1127<!--/count--> tests. It takes every honest example round and changes one thing a seller could change in the published files (a bid amount off by one zatoshi, the price, a winner, a refund, a payment left out or listed twice, a bid moved past the close, another lot's key, two refund addresses swapped), one at a time. None of the changed copies may pass. The expected answers were written at the top of `test/tamper/matrix.test.ts` before the first run. That run found one real gap: a refund for a late bid, left out of the seller's files, passed at the key level. It is fixed in `src/check.ts` and the test now guards it.

It also checks the opposite: reordering lists or fields changes nothing, and the same round checked twice gives the same verdict word for word.

## A real round on the Zcash test network

| What | Command | Result |
|---|---|---|
| Check the real round from the saved blocks | `npx @sireadell/imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --chain examples/testnet-01/chain.json` | `PASS (21 of 21)`. The scan reads all 34 blocks (80 transactions) and the lot key sees exactly 6: 3 bids and 3 refunds |
| Fetch the same blocks from public servers instead of trusting the file | `LIVE=1 npm run test:scan` | Two independent servers must agree on every block, then the same `PASS` |
| Look up a payment yourself | The explorer links in `examples/testnet-01/README.md` | Each of the 6 transactions exists at the block the checker reports |
| A bidder checks their own bid | `npx @sireadell/imani check ... --mine 2f5e8f4f37` | Counted, did not win, full refund owed, refund reached the address in the bid memo |
| Sign in with a real wallet | `npx tsx --test test/login/real-wallet.test.ts` | One real test-network payment logs in. A second use, a missing proof, an expired code and a different site are all refused |

The second live test, `LIVE=1 npm run test:fetch`, reads a main-network transaction from two public servers and checks they agree.

## Privacy checks

| Check | Command | What it proves |
|---|---|---|
| No secrets in the files | `npm run leak-scan` | No tracked file holds something shaped like a viewing key, spending key or seed phrase, except public test keys listed with a reason in `tools/leak-scan.allow.json` |
| No secrets in the history | `npm run leak-scan:history` | The same scan over every file of every commit |
| The checker page stays offline | `npm run test:site` | The built checker page contains no network call, and its security policy forbids one (`connect-src 'none'`). The "Check any round" page is tested to send nothing until the reader says yes |
| Refunds that can be followed | `npx @sireadell/imani linking examples/testnet-01/disclosure.json` | 0 links that reach outside the real round |
| Who learns what | `npm run who-learns` | Rebuilds `docs/WHO_LEARNS_WHAT.md` from the real round; a test fails if the table drifts |

## Install from scratch

`test/pack.test.ts` packs the package, installs it in an empty folder and runs a check, inside 120 seconds. From a fresh copy, `npm ci` and `npm run demo` each take a few seconds and the demo prints the same PASS and two FAILs the judge guide describes.
