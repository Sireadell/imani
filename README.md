# Imani

*Imani means "trust" in Swahili.*

Imani checks that a sealed-bid auction on Zcash was run fairly. When bidding closes, the seller publishes a read-only viewing key for that one lot: it can show the lot's private payments but can never spend them. Imani reads the bids and refunds with that key and public chain data, works out the winners, the price and every refund again, and compares them with the seller's published result. You get PASS or FAIL, with the failed check named. It's built for bidders who want to know their bid was counted and their refund was right, and for sellers who want to show a clean round. Since the key and the blocks are public, anyone else can run it too.

There's a smaller second tool in the box: a sign-in button any website can add, where you log in by sending a tiny private payment from a shielded Zcash wallet. [More below](#also-sign-in-by-paying-from-a-private-zcash-wallet).

## Try it in under a minute

In your browser: **https://imani-check.vercel.app** opens on a real auction from the Zcash test network and checks it on your own computer. After it loads, that page makes no network requests.

On your computer, with Node 22.18 or newer, in this folder:

```sh
npm install
npm run demo
```

It checks one small auction three ways in about two seconds, with no internet. The honest round ends `RESULT: PASS`. A copy where the seller refunded a losing bidder 100,000 zatoshis short ends `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. In the third copy the seller left a 3,000,000 bid out of their files, and reading every block of the auction finds it: `RESULT: FAIL (1 of 20 checks failed: scan-hidden-bids)`.

## What to run for each judging line

| Line | Run or open | What you will see |
|---|---|---|
| Privacy | `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --offline --discreet` | `Servers contacted: none`, `RESULT: PASS (16 of 16 checks passed)`, and no amount, memo or address anywhere in the output. The key is accepted as read-only and is never printed or saved. Then `npx imani linking examples/testnet-01/disclosure.json` prints `RESULT: NO LINKS OUTSIDE THE ROUND`: no refund can be followed past the bid it pays back. Who can learn what: [docs/WHO_LEARNS_WHAT.md](docs/WHO_LEARNS_WHAT.md) |
| Usefulness | `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --mine 2f5e8f4f37` | One bidder's answer from the real round: `Your bid: counted, 1,500,000 zat.`, it did not win, the whole bid is owed back, and the refund went to the address that bidder wrote in their bid memo. For any round, open https://imani-check.vercel.app/check.html, paste its viewing key and blocks, and get PASS or FAIL from the chain alone |
| Execution | `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --fetch` | Downloads the real round's 34 blocks from two public test-network servers run by different people, which must agree on every block, then `RESULT: PASS (21 of 21 checks passed)` in about 40 seconds. Use `--chain examples/testnet-01/chain.json` instead of `--fetch` to read the saved copy offline in about 3 seconds |
| Originality | `git log --reverse --format="%ad %s" --date=short` | The first commit, dated 2026-10-07. The build window opened on 2026-09-28 |

The whole test suite is `npm run test:all` (about six minutes). `npm test` runs the checker's own tests in about a minute.

## Real counts

| What | Count | Where it comes from |
|---|---|---|
| Tests | 1,534 in 9 groups, 1,531 pass and 3 are skipped unless you ask for the live ones | [docs/HOW_WE_TESTED.md](docs/HOW_WE_TESTED.md), rewritten by the test run itself |
| Tests that change one fact at a time and must never pass | 1,127 | `npm run test:tamper` |
| Example rounds | 10 that pass: 1 real, 9 made up offline with throwaway keys | `examples/` |
| Broken copies | 42 in 9 folders, each named for what the seller changed, and all 42 fail | `examples/*broken*/manifest.json` |
| Real round on the Zcash test network | `testnet-01`: 3 bids and 3 refunds, all paid into the Ironwood pool, 34 blocks holding 80 transactions, 21 of 21 checks pass | [examples/testnet-01/README.md](examples/testnet-01/README.md), with an explorer link for each payment |

## New this week

| Feature | What it does | Try it |
|---|---|---|
| Sealed lots | Every bidder pays the same deposit and the memo holds only a sealed fingerprint of their price, so the seller can't read prices before the close. Bidders open their seal afterwards | `examples/sealed-01` passes, 8 broken copies in `examples/sealed-broken`. Plan: [docs/SELLER_BLIND_PLAN.md](docs/SELLER_BLIND_PLAN.md) |
| Fundraisers and group buys | All or nothing: if on-time payments reach the goal they're all kept, and if not every one is refunded in full | `examples/goal-reached`, `examples/goal-missed`, 4 broken copies in `examples/goal-broken` |
| Two price rules, and top-ups | Price at the highest losing bid or the lowest winning bid. With top-ups a bidder can raise their bid by paying again under the same memo before the close | `examples/pricing-01`, 5 broken copies in `examples/pricing-broken`. Top-ups are covered in `test/pricing.test.ts` |
| Published totals | Payments, received, kept and refunded must add up and match the chain | `examples/totals-01`, 4 broken copies in `examples/totals-broken` |
| Bid links with QR codes | `imani bid-link` turns a bid into a ZIP 321 `zcash:` payment link and QR code, so a wallet fills in the address, amount and memo | [docs/BID_LINK.md](docs/BID_LINK.md) |
| Seller kit | `imani lot-new` sets up a lot and `imani settle` works out every refund owed and writes the two files to publish | [docs/SELLER_KIT.md](docs/SELLER_KIT.md) |
| Checked rounds list | One page with every round we ship or have checked, each with a button to re-check it in your browser | https://imani-check.vercel.app/rounds.html |
| Scale test | 17,000 generated payments, the size of a 16,971-bid sealed auction on Zcash this year: the seller-file checks take well under a second (about 50 ms in the scale notes, 143 ms on our last run). Reading real transactions with a key measured 16.8 ms each, so about 5 minutes for 17,000. That second figure is an estimate, not a run | `npx tsx --test test/scale.test.ts`, notes in [docs/SCALE.md](docs/SCALE.md) |

The 17,000 payments are made-up amounts built from a fixed seed. Imani has not been run on that real auction's data.

## Zcash pieces it uses

| Piece | How |
|---|---|
| Viewing keys (ZIP 316 unified full viewing keys) | The only key the checker accepts (`uview1` or `uviewtest1`). Spending keys and seed phrases are refused |
| Memos | Bids, refunds and seals are read from memos, and a bidder can put their own refund address at the end of their bid memo |
| Orchard and Ironwood pools | Both are read. The real test-network round was paid entirely in Ironwood |
| librustzcash | Our transaction reader is a thin wrapper around it, built to WebAssembly so the same code runs in Node and the browser. SHA-256 of each file is in [vendor/decoder/SHA256SUMS](vendor/decoder/SHA256SUMS), source in [tools/decoder](tools/decoder) |
| lightwalletd and Zebra | `--fetch` reads blocks from two independent public sources that must agree. Or use your own lightwalletd server or Zebra node (see [Safety](#safety)) |
| ZIP 321 payment requests | The `zcash:` links and QR codes made by `imani bid-link` |

## What this is not

- In a plain lot it doesn't prove the seller never looked at bids as they came in. It proves the counting, price and refunds are right. Sealed lots close that gap.
- It needs the seller to publish the lot's viewing key. A seller who never does can't be checked past the basic level.
- It isn't a zero-knowledge proof. You work the result out yourself from data the seller chose to share.
- A payment sent through a NEAR Intents route carries no memo, so it can't be a bid and can't name a refund address. We haven't tested that route.
- No PCZT and no FROST.
- The bid link QR code has not yet been tested with a wallet. The link format and the QR are checked in tests, not by paying from one.
- The 17,000-payment scale round is generated, not real.
- <!-- MAINNET-LINE -->Our real round ran on the Zcash test network with test coins. We haven't run a round on mainnet.<!-- /MAINNET-LINE -->

Every check and every known limit is in [SPEC.md](SPEC.md).

## Where every number comes from

| Source | What it gives |
|---|---|
| The chain, read with the lot key | Bid amounts, bid memos, refund amounts, refund memos, where each refund was paid, transaction ids |
| The seller's result file | The bid list, winners, clearing price, reserve outcome and refund list the seller claims |
| The seller's disclosure file | Close height, block height of each transaction, item count, reserve and, if listed, the refund address of each bid |
| Every block of the auction, with `--scan` | Any payment the seller left out, and the real block height of each listed one |

The report shows each check with PASS or FAIL, a one-line reason, and which numbers came from where. Add `--out report` to also write `report/verdict.json` and `report/report.html`, which opens offline in any browser. A bidder with no help from the seller can run `imani bidder-check` with only their own viewing key ([docs/BIDDER_CHECK.md](docs/BIDDER_CHECK.md)). Rounds published by another Zcash auction project can be worked out again from their own files ([docs/EXTERNAL_ROUNDS.md](docs/EXTERNAL_ROUNDS.md)).

## Safety

The checker contacts no server unless you add `--fetch`, and every run prints the servers it used. With `--fetch` it asks for blocks by number, never sends a key, and only passes when two sources run by different people agree on every block. `npm run leak-scan` and `npm run leak-scan:history` look for anything shaped like a key or seed phrase in every tracked file and in every past commit. CI runs both.

To skip other people's servers, point it at your own:

| You run | Add |
|---|---|
| A light server | `--server https://your-server:443` |
| A Zebra node (mainnet) | `--server zebra+http://127.0.0.1:8232 --zebra-auth-file <path to Zebra's .cookie>` |
| A Zebra node (testnet) | `--server zebra+http://127.0.0.1:18232 --zebra-auth-file <path to Zebra's .cookie>` |

Your node's password is read from that file, never printed, and never sent unencrypted to a machine that isn't yours.

## Also: sign in by paying from a private Zcash wallet

You sign in by sending a tiny private payment from any shielded Zcash wallet. Your account is a random login key kept on your device, not a Zcash key, so it survives a change of wallet address. The kit is `src/login` (exported as `imani/login`), the format is in [LOGIN_SPEC.md](LOGIN_SPEC.md), and `npm run demo:app` runs a small auction shop that uses it. Seeing someone's sign-in link or QR doesn't let you log in as them, because the site also needs a proof only their login key can make. Its limits are in LOGIN_SPEC.md, section 9.

## More

A step-by-step guide for judges: [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md). How every test group was run: [docs/HOW_WE_TESTED.md](docs/HOW_WE_TESTED.md).

Built for Zecathon, Core & Tooling track. All code was written in the build window: the first commit is dated 2026-10-07.

Licence: MIT. [THIRD_PARTY.md](THIRD_PARTY.md) lists the libraries used.
