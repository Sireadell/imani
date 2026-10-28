# Proof file

Every headline claim of this project, with the one command that proves it and the exact line that command prints. Run the command from the root of a checkout (after `npm ci`) and look for the line in the last column. Nothing here needs a network, a wallet or a key: the keys in the examples are public test keys, and the rounds are read from the files in `examples/`.

To check the whole table in one go: `node tools/proof-run.ts` runs every quick row and compares the printed line with the one below (it exits with an error if any line differs). `node tools/proof-run.ts --all` also runs the slow rows.

| Claim | Command | Result line |
|---|---|---|
| A real round on the Zcash test network checks PASS, with all its checks | `node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --chain examples/testnet-01/chain.json` | `RESULT: PASS (21 of 21 checks passed)` |
| The scan of that test network round read every block in its range (34 blocks, 80 transactions) | `node bin/imani.js check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --chain examples/testnet-01/chain.json` | `PASS  [scan level] Every block in the lot's range was read. Read all 34 blocks from 4489077 to 4489110 (80 transactions) from the chain file chain.json (offline). Every transaction id was recomputed from its bytes. The lot key sees 6 of them.` |
| A real round on Zcash mainnet checks PASS, with all its checks | `node bin/imani.js check --disclosure examples/mainnet-01/disclosure.json --result examples/mainnet-01/result.json --scan --chain examples/mainnet-01/chain.json` | `RESULT: PASS (23 of 23 checks passed)` |
| The scan of that mainnet round read every block in its range (61 blocks, 482 transactions) | `node bin/imani.js check --disclosure examples/mainnet-01/disclosure.json --result examples/mainnet-01/result.json --scan --chain examples/mainnet-01/chain.json` | `PASS  [scan level] Every block in the lot's range was read. Read all 61 blocks from 3532593 to 3532653 (482 transactions) from the chain file chain.json (offline). Every transaction id was recomputed from its bytes. The lot key sees 6 of them.` |
| A changed copy of a round fails, and the checker names the check it broke (here: a refund that is too small) | `node bin/imani.js check --disclosure examples/broken/04-short-refund/disclosure.json --result examples/broken/04-short-refund/result.json` | `RESULT: FAIL (1 of 15 checks failed: refunds-paid)` |
| The conformance kit says FULL, 52 of 52 verdicts right, honest rounds and changed copies alike | `npm run conformance --silent -- --cmd "node bin/imani.js check"` | `Conformance: FULL (52 of 52 verdicts right, 42 of 42 broken copies named correctly)` |
| The browser build checks the real round and a changed copy with the same verdict as the command line (slow: builds the browser file first) | `npx tsx --test test/browser-bundle.test.ts` | `# pass 3` |
| The leak scan is clean: no viewing key, spending key, seed phrase or .env in any tracked file | `npm run leak-scan --silent` | `leak-scan: clean. No viewing key, spending key, seed phrase or .env in any tracked file (10 allowlisted public test-key paths).` |
| The leak scan is clean in the whole history, not only the current files (slow: reads every commit) | `npm run leak-scan:history --silent` | `leak-scan: clean. No viewing key, spending key, seed phrase or .env in any file of any commit in the history (10 allowlisted public test-key paths).` |
| The test count in the README is the real count from a full run (slow: about 10 minutes) | `npm run test:all` | `test:all: <!--count:total-->1690<!--/count--> tests in <!--count:groups-->9<!--/count--> groups, <!--count:pass-->1687<!--/count--> passed, <!--count:skipped-->3<!--/count--> skipped, 0 failed.` |

## What is not claimed here

- The command `imani` comes from the package `@sireadell/imani` in this repository (also on npm as version 0.0.1). The table runs it from a checkout as `node bin/imani.js`.
- The table covers the checker in this repository only.
- A PASS says the published numbers add up with what the lot's key can read. It does not say the seller picked the right winners by any rule beyond the ones in the disclosure.

## Which rows `node tools/proof-run.ts` skips

By default it skips the slow rows: the whole test run (`npm run test:all`), the conformance kit, the browser build test and the leak scan over the history. `--all` runs them too. The automatic test in `test/proof-file.test.ts` skips the same four.
