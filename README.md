# Imani

[![tests on Windows, macOS and Linux](https://github.com/Sireadell/imani/actions/workflows/ci.yml/badge.svg)](https://github.com/Sireadell/imani/actions/workflows/ci.yml)

*Imani means "trust" in Swahili.*

Imani is a Zcash tool: a TypeScript library and a command line that read shielded Zcash payments with a read-only viewing key and check them against what someone published about them.

| Part | What it is |
|---|---|
| Payment reader | librustzcash, Zcash's own Rust code, compiled to WebAssembly (a format that runs the same code in Node and in a web browser). It reads Orchard and Ironwood payments, their amounts and memos, with a ZIP 316 viewing key, and refuses spending keys and seed phrases. Source in [tools/decoder](tools/decoder) |
| Library | `import { checkLot } from "imani"`, plus the reader, the bid-link maker and the rest. The command line and the browser page run the same code |
| Command line | `imani check` checks a whole round from one read-only viewing key plus public chain data. With `--fetch` it downloads every block from two block servers run by different people and passes only when both agree. Or point it at your own lightwalletd server or Zebra node |

```js
import { checkLot } from "imani";
const verdict = checkLot(disclosure, result); // the seller's two published files, as parsed JSON
console.log(verdict.result, verdict.failed);   // PASS [], or FAIL [ 'refunds-paid' ] for a short refund
```

Every function and type, what it takes, and whether it uses the network: [docs/LIBRARY.md](docs/LIBRARY.md). To run a worked example: `npm run build`, then `node examples/library/check-a-round.mjs`.

The job it does today is checking sealed-bid auctions on Zcash. When bidding closes, the seller publishes a read-only viewing key for that one lot: it can show the lot's private payments but can never spend them. Imani reads the bids and refunds with that key and public chain data, works out the winners, the price and every refund again, and compares them with the seller's published result. You get PASS or FAIL, with the failed check named. It's built for bidders who want to know their bid was counted and their refund was right, and for sellers who want to show a clean round. Since the key and the blocks are public, anyone else can run it too.

There's a smaller second tool in the box: a sign-in button any website can add, where you log in by sending a tiny private payment from a shielded Zcash wallet. [More below](#also-sign-in-by-paying-from-a-private-zcash-wallet).

## Try it in under a minute

In your browser: **https://imani-check.vercel.app** opens on a real auction from the Zcash test network and checks it on your own computer. After it loads, that page makes no network requests.

For an answer a script can read, the same site has a web link that checks the real round and returns JSON:

```sh
curl "https://imani-check.vercel.app/api/check?round=testnet-01"
```

You get `verdict` (PASS or FAIL), `checks` (21 of 21 pass today), the `failed` list, the network, lot and block range (4,489,077 to 4,489,110, 34 blocks), `source` and `tookMs`. It runs the same every-block checker as the command line, on the saved blocks in `examples/testnet-01`, so it contacts no servers. To download the blocks again from public servers, use the command line with `--fetch`. It takes only a round name from a fixed list (`testnet-01` for now), never a key or a file, and holds no key itself.

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
| Execution | `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --fetch` | Downloads the real round's 34 blocks from two public test-network servers run by different people, which must agree on every block, then `RESULT: PASS (21 of 21 checks passed)` in about a minute. Use `--chain examples/testnet-01/chain.json` instead of `--fetch` to read the saved copy offline in about 3 seconds |
| Originality | [examples/testnet-01/README.md](examples/testnet-01/README.md), no git needed | The real round was paid on the public Zcash test network on 2026-10-11, and each payment's explorer link shows its block and date on the chain, which nobody can backdate. The build window opened on 2026-09-28. In a git clone, `git log --reverse --format="%ad %s" --date=short` also shows the first commit, dated 2026-10-07 (this needs the clone, a ZIP download has no history) |

About the "check any round" page: public block servers do not let a web page ask them for blocks, so a live check on that page downloads blocks through our own hosted address (`/api/block`). Only a network name and block numbers go through it, never a key, and the key stays in your tab (like any website, it also sees your IP address). To leave our server out, run `node tools/referee-serve.ts` and open the same page from your own computer, which then asks the two public servers itself. To use no network at all, pick a saved block file on the page, or run `npx imani check --disclosure <file> --result <file> --scan --chain <block file>`.

The whole test suite is `npm run test:all` (about nine minutes). `npm test` runs the checker's own tests in about a minute.

## Core & Tooling, line by line

| Line | What Imani has | File | Command |
|---|---|---|---|
| Zebra | A `zebra+http://` source that reads blocks straight from your own Zebra node, with Zebra's cookie password read from its `.cookie` file and never printed. Tested against a fake node that answers like Zebra's own code, filled with real test-network blocks. It has not been run against a real Zebra node yet | [src/fetch/zebra.ts](src/fetch/zebra.ts), tests in [test/fetch/zebra.test.ts](test/fetch/zebra.test.ts) | `npx tsx --test test/fetch/zebra.test.ts`. With a node of your own: `LIVE=1 IMANI_ZEBRA_URL=zebra+http://127.0.0.1:18232 npm run test:fetch` |
| librustzcash | The payment reader is librustzcash compiled to WebAssembly: zcash_client_backend 0.25.0-pre.1, zcash_primitives 0.31.0-pre.1, zcash_keys 0.17.0-pre.1, zcash_protocol 0.11.0-pre.0, orchard 0.16.0, sapling-crypto 0.9.0. It reads up to NU7. The SHA-256 of every built file is checked by a test | [tools/decoder/Cargo.toml](tools/decoder/Cargo.toml), built files and [SHA256SUMS](vendor/decoder/SHA256SUMS) in `vendor/decoder` | `bash tools/decoder/build.sh` rebuilds it, `npx tsx --test test/vendor.test.ts` checks the hashes |
| Indexers | A small lightwalletd client written by hand (no extra packages), which also talks to Zaino. Every block and transaction must come back the same from two servers run by different people, and every transaction id is worked out again from the bytes | [src/fetch/grpc.ts](src/fetch/grpc.ts), [src/scan/fetch-blocks.ts](src/scan/fetch-blocks.ts), [docs/fetch/DESIGN.md](docs/fetch/DESIGN.md) | `npm run test:fetch` (fake servers, no network). Live: `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --fetch` |
| Wallet SDKs | A library other wallets and apps can import. It accepts only ZIP 316 read-only viewing keys and refuses spending keys and seed phrases. It makes ZIP 321 `zcash:` bid links with QR codes, which a test scans back with a separate QR reader. The block downloader, the every-block scan that finds a bid the seller left out, and the sealed-lot rules are plain functions too (`fetchBlocks`, `scanFromChain`, `fetchScan`, `openSeals`, `sealHash`), so an app can run the full check without the command line | [src/index.ts](src/index.ts), [docs/LIBRARY.md](docs/LIBRARY.md), [src/bidlink.ts](src/bidlink.ts) | After `npm run build`: `node examples/library/check-a-round.mjs`, and `node examples/library/catch-a-hidden-bid.mjs`, which prints the real round passing 21 of 21 and a copy with a hidden bid failing on `scan-hidden-bids`. `npx tsx --test test/check.test.ts test/bidlink.test.ts` |
| Proof of one payment | `imani bid-proof make` turns one bid into a small file anyone can check with no viewing key. It holds that one payment's opening key (the one-time secret Zcash encrypts each payment with), which opens that bid and no other. librustzcash refuses to open it unless the amount, memo and lot address match what the transaction committed to, and the checker confirms the block from two servers. Same idea as ZIP 311 payment disclosures. Only made by the lot owner on a real round so far, and it proves a payment was made, not who made it | [docs/BID_PROOF.md](docs/BID_PROOF.md), [src/bid-proof.ts](src/bid-proof.ts), source of the opener in [tools/disclose](tools/disclose) | `npx imani bid-proof check --proof examples/bid-proof-01/proof.json --facts examples/bid-proof-01/lot-public.json --result examples/testnet-01/result.json --fetch` prints `RESULT: PASS (9 of 9 lines proven)` for a real 3,000,000 bid. `--chain examples/testnet-01/chain.json` instead of `--fetch` runs it offline |
| Lot file format | A written contract for the two files a seller publishes, with a JSON schema for each, so any project can publish them and any checker can read them. A kit of 52 rounds with known answers grades a checker written in any language: 10 honest rounds must PASS, 42 broken copies must FAIL and name the check that caught them | [docs/FORMAT.md](docs/FORMAT.md), [schema/](schema) | `npm run conformance -- --cmd "node bin/imani.js check"` prints `Conformance: FULL (52 of 52 verdicts right, 42 of 42 broken copies named correctly)` |
| Mainnet chain check | Ties a real mainnet round run by another Zcash auction project to the chain: its 3 listed payments are fetched from two independent servers, which must return the same bytes, and each transaction id is worked out again from those bytes. They were mined in blocks 3,499,413 and 3,499,451. It cannot read the amounts, because that round's viewing key was never published | [src/external/anchor.ts](src/external/anchor.ts), saved copy in [test/external/round-files/demo01-chain.json](test/external/round-files/demo01-chain.json) | `npm run check:external -- test/external/round-files/demo01-settlement.json --fetch`, or `--chain test/external/round-files/demo01-chain.json` instead of `--fetch` to read the saved copy offline |

## Real counts

| What | Count | Where it comes from |
|---|---|---|
| Tests | <!--count:total-->1601<!--/count--> in <!--count:groups-->9<!--/count--> groups, <!--count:pass-->1598<!--/count--> pass and 3 are skipped unless you ask for the live ones | [docs/HOW_WE_TESTED.md](docs/HOW_WE_TESTED.md), rewritten by the test run itself |
| Tests that change one fact at a time and must never pass | <!--count:test:tamper-->1127<!--/count--> | `npm run test:tamper` |
| Example rounds | 10 that pass: 1 real, 9 made up offline with throwaway keys | `examples/` |
| Broken copies | 42 in 9 folders, each named for what the seller changed, and all 42 fail | `examples/*broken*/manifest.json` |
| Real round on the Zcash test network | `testnet-01`, lot name `DRY-01` (DRY for dry run: a real round paid with test coins before any real money). 3 bids and 3 refunds, all paid into the Ironwood pool, 34 blocks holding 80 transactions, 21 of 21 checks pass | [examples/testnet-01/README.md](examples/testnet-01/README.md), with an explorer link for each payment |
| Conformance kit | 52 rounds with known answers: 10 must PASS, 42 broken copies must FAIL and name the right check. Our checker gets 52 of 52 and names 42 of 42 | [docs/FORMAT.md](docs/FORMAT.md), `npm run conformance -- --cmd "node bin/imani.js check"` |
| Payments of a real mainnet round, tied to the chain | 3 of 3, from a round run by another Zcash auction project. Two independent servers returned the same bytes for each, mined in blocks 3,499,413 and 3,499,451. Amounts not read, since no key was published | [src/external/anchor.ts](src/external/anchor.ts), `npm run check:external -- test/external/round-files/demo01-settlement.json --fetch` |

## What else it checks and makes

| Feature | What it does | Try it |
|---|---|---|
| Sealed lots | Every bidder pays the same deposit and the memo holds only a sealed fingerprint of their price, so the seller can't read prices before the close. Bidders open their seal afterwards | `examples/sealed-01` passes, 8 broken copies in `examples/sealed-broken`. Plan: [docs/SELLER_BLIND_PLAN.md](docs/SELLER_BLIND_PLAN.md) |
| Fundraisers and group buys | All or nothing: if on-time payments reach the goal they're all kept, and if not every one is refunded in full | `examples/goal-reached`, `examples/goal-missed`, 4 broken copies in `examples/goal-broken` |
| Two price rules, and top-ups | Price at the highest losing bid or the lowest winning bid. With top-ups a bidder can raise their bid by paying again under the same memo before the close | `examples/pricing-01`, 5 broken copies in `examples/pricing-broken`. Top-ups are covered in `test/pricing.test.ts` |
| Published totals | Payments, received, kept and refunded must add up and match the chain | `examples/totals-01`, 4 broken copies in `examples/totals-broken` |
| Bid links with QR codes | `imani bid-link` turns a bid into a ZIP 321 `zcash:` payment link and QR code, so a wallet fills in the address, amount and memo | [docs/BID_LINK.md](docs/BID_LINK.md) |
| Seller kit | `imani lot-new` sets up a lot and `imani settle` works out every refund owed and writes the two files to publish. A seller can run `imani settle --fetch` right after the close, before the refund deadline: it reads up to the newest block, lists the refunds to pay, and says plainly which blocks are still to come, so it never passes early | [docs/SELLER_KIT.md](docs/SELLER_KIT.md), `npx tsx --test test/settle-early.test.ts` |
| Proof of one bid | `imani bid-proof` lets a bidder or the seller show one bid to someone else (a friend, an arbiter, a judge) without handing over a viewing key. The other person sees that bid's amount, memo and block, and nothing about the other bids | `npx imani bid-proof check --proof examples/bid-proof-01/proof.json --facts examples/bid-proof-01/lot-public.json --result examples/testnet-01/result.json --chain examples/testnet-01/chain.json`, more in [docs/BID_PROOF.md](docs/BID_PROOF.md) |
| Checked rounds list | One page with every round we ship or have checked, each with a button to re-check it in your browser | https://imani-check.vercel.app/rounds.html |
| Scale test | 19,000 payments generated to the published size (made-up amounts from a fixed seed), more than the 16,971 bids reported for a big public sealed auction on Zcash this year: the seller-file checks take well under a second (about 50 ms in the scale notes, 143 ms on our last run). Reading real transactions with a key measured 16.8 ms each, so about 5 minutes for 19,000. That second figure is an estimate, not a run | `npx tsx --test test/scale.test.ts`, notes in [docs/SCALE.md](docs/SCALE.md) |

The 19,000 payments are made-up amounts built from a fixed seed. Imani has not been run on that real auction's data.

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
- A bid proof proves that a payment was made, not who made it: anyone holding the file can show it, like a receipt. Only the lot-owner way of making one has run on a real round. A bidder making one from their own wallet uses the same code but hasn't been tried on a real wallet. Sealed lots and Sapling payments aren't covered, and for a bid raised with top-ups it can't confirm the seller counted the full amount.
- The bid link QR code has not yet been tested with a wallet. The link format and the QR are checked in tests, not by paying from one.
- The 19,000-payment scale round is generated to the published size, with made-up amounts from a fixed seed. It is not real.
- The Zebra node route has been tested only against a fake node that answers in the shape of Zebra's own code, filled with real test-network blocks. It has not yet been run against a live Zebra node.
- <!-- MAINNET-LINE -->Our real round ran on the Zcash test network with test coins. We haven't run a round on mainnet.<!-- /MAINNET-LINE -->

Every check and every known limit is in [SPEC.md](SPEC.md).

## Who could cheat, and what catches them

| Who | Caught, by check id | Not caught (stated limits) |
|---|---|---|
| Dishonest seller | Fake bid `bid-count`, wrong amount `bid-amounts`, short or missing refund `refunds-paid`, wrong price `winners-and-price`, late bid counted `no-late-bids`, hidden bid `scan-hidden-bids`, false block number `scan-heights`, refund to the wrong address `refund-receivers`, books that do not add up `refund-total` | A shill bid paid from the seller's own second wallet. Peeking at bids in a plain lot. A refund paid to themselves when no refund address is in the memo or the list |
| Dishonest bidder | Same memo sent twice `no-duplicate-bids`. A late bid or late top-up is never counted and is owed back in full | Showing someone else's bid proof as their own. A stray payment to the lot address makes an honest round fail `key-hygiene` |
| Lying block server | With `--fetch`, two servers run by different people must agree on every block and every byte, or the run stops. A missing or altered block fails `scan-blocks-read` | Two servers working together to hide the same bid. A doctored saved chain file |
| Lot-key holder | Cannot move money: the key only reads. A reused seller key `key-hygiene`. A refund address reused across rounds is reported by `imani linking` | Sees every bid and refund of the lot, including which refund went to which bid, so they can link a bidder's bid to the refund address written in its memo. `--discreet` only hides what Imani prints |

The full table, with the example or test behind each row: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

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
