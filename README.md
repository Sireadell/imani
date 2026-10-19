# Imani

*Imani means "trust" in Swahili.*

After a sealed-bid auction on Zcash closes, the seller shares a one-time read-only viewing key for that lot. Imani reads the lot's private payments with that key, works out the bids, the winner, the clearing price and the refunds again, and compares them to the seller's published result: PASS or FAIL, with the failed check named.

**Try it in your browser: https://imani-check.vercel.app** opens on a real auction from the Zcash test network and checks it on your own computer. You can also drop a seller's disclosure file and result file onto the page and get the verdict in the browser. After it loads, that page makes no network requests. The separate "Check any round" page (`check.html`) is different: it asks first, and only after you press its button does it fetch blocks through our site from two public Zcash servers, which see the block numbers you asked for. Your viewing key stays in your browser.

## Try it in one minute

You need Node 22.18 or newer. In this folder:

```sh
npm install
npm run demo
```

You will see three checks of the same small auction. The first is the honest round and ends with `RESULT: PASS`. The second is a copy where the seller paid a losing bidder 100,000 zatoshis too little, and it ends with `RESULT: FAIL (1 of 15 checks failed: refunds-paid)`. In the third, the seller left a 3,000,000 bid out of their files entirely. The normal check cannot see it, because it only reads what the seller lists. The scan reads every block of the auction and ends with `RESULT: FAIL (1 of 20 checks failed: scan-hidden-bids)`. It takes about two seconds and needs no internet.

To check a real round, paid by a real wallet on the Zcash test network: `npx imani check --disclosure examples/testnet-01/disclosure.json --result examples/testnet-01/result.json --scan --chain examples/testnet-01/chain.json` ends with `RESULT: PASS (21 of 21 checks passed)`.

To check a lot yourself:

```sh
npx imani check --disclosure examples/round-01/disclosure.json --result examples/round-01/result.json --out report
```

This prints every check and writes `report/verdict.json` and `report/report.html` (open it in any browser, it works offline). Add `--discreet` to hide amounts, memos and addresses, `--offline` to make sure no connection is ever opened, or `--basic` to run only the checks that need no key. Nothing shaped like a key or seed phrase can be printed or written. `npm run leak-scan` checks every tracked file for keys, seed phrases and `.env` files (public test keys are listed with a reason in `tools/leak-scan.allow.json`). `npm run leak-scan:history` does the same for every file in every commit, so a key that was committed and later deleted is still found. CI runs both. Try the six broken copies in `examples/broken/`: each one fails on exactly one named check, listed in `examples/broken/manifest.json`.

Bidders can add `--mine <your bid's transaction id>` (the first 10 characters are enough) to any check. It prints whether your bid was counted, whether it won, what should come back to you, and what the checks found about it. With `--scan` it also tells you if the seller left your bid out.

To see how far a refund can be followed, run `npx imani linking examples/testnet-01/disclosure.json`. Inside a round each refund names its bid on purpose, so anyone can check it. The command counts the links that reach further: one receiver paid for two bids, or the same receiver paid in two rounds (give it several disclosures to compare rounds). A bidder who writes a fresh address in each bid memo leaves no such link.

To also read every block of the auction, so a bid the seller left out still shows up:

```sh
npx imani check --disclosure examples/scan-01/disclosure.json --result examples/scan-01/result.json --scan --chain examples/scan-01/chain.json
```

This reads the blocks from a saved file. Use `--fetch` instead of `--chain` to download them from public Zcash servers (slower: about an hour for a day-long auction, see SPEC.md). `examples/scan-broken/` has three copies that only the scan catches: a hidden bid, a listed payment that is not on the chain in time, and a wrong block height.

To also check where each refund went, the bidder can write their refund address at the end of their bid memo (`bid:<lot>:<word>:<address>`), so the seller cannot choose it. `examples/memo-01` passes and `examples/memo-broken/` has two copies that fail `refund-receivers`. Or the seller can list the address each bid's refund must go to (`refundAddresses` in the disclosure). `examples/receivers-01` passes, and `examples/receivers-broken/` has two copies that fail `refund-receivers`: a refund that went to a different address than the one listed, and a bid with no address listed. `npm run examples:receivers` rebuilds them.

## Where every number comes from

| Source | What it gives |
|---|---|
| The chain, read with the lot key | Bid amounts, bid memos, refund amounts, refund memos, where each refund was paid, transaction ids |
| The seller's result file | The bid list, winners, clearing price, reserve outcome and refund list the seller claims |
| The seller's disclosure file | Close height, block height of each transaction, item count, reserve and, if listed, the refund address of each bid |
| Every block of the auction, with `--scan` | Any payment the seller left out, and the real block height of each listed one |

The checker works the result out again from the chain numbers and compares it with the seller's file. The report shows each check with PASS or FAIL, a one-line reason, and which numbers came from where.

## What it is

A checker for sealed-bid auctions on Zcash. The seller shares a one-time read-only key for the lot after the close, imani reads the lot's private payments with that key, works out the bid count, amounts, winners, price and refunds again, and compares them to the seller's published result: PASS or FAIL.

It also ships a small second tool, a login button any website can add ([see below](#also-sign-in-with-a-private-zcash-wallet)).

The file formats, price rule, every check and the known limits are in [SPEC.md](SPEC.md).

## Safety

The checker only accepts a read-only viewing key (starts with `uview1` or `uviewtest1`). It refuses seed phrases and spending keys, never prints the key and never saves it. If the key shows payments that are not bids for the lot, the check fails and tells the seller to use a fresh key for every lot. By default it contacts no server and prints `Servers contacted: none`. Only `--scan --fetch` goes online. It asks for blocks by number, never sends a key, and prints every server it used. It reads each block from two public sources run by different people, and only passes when they agree on every block.

If you'd rather not depend on anyone else's server, point it at your own:

| You run | Add |
|---|---|
| A light server | `--server https://your-server:443` |
| A Zebra node (mainnet) | `--server zebra+http://127.0.0.1:8232 --zebra-auth-file <path to Zebra's .cookie>` |
| A Zebra node (testnet) | `--server zebra+http://127.0.0.1:18232 --zebra-auth-file <path to Zebra's .cookie>` |

Your node's password is read from that file, never printed, and never sent unencrypted to a machine that isn't yours.

## Honest limits: the auction check

- A refund is proven to have left the lot with the right amount and memo. Where it went is compared with the refund address the seller lists for each bid. That list is the seller's word, so a seller could list their own address. Each bidder should check the address next to their bid is theirs, or give their own viewing key, which proves their refund arrived.
- Block heights are checked against the chain only with `--scan`. A saved chain file is only as trustworthy as where you got it. With `--fetch`, two independent operators must agree (on the test network, a light server and the CipherScan explorer).
- It reads only what the seller shares. A bid paid before the open height is not seen.

## Also: sign in by paying from a private Zcash wallet

A login button any website can add. You sign in by sending a tiny private payment from any shielded Zcash wallet. Your account is a random login key kept on your device, not a Zcash key, so it survives a change of wallet address. The kit is `src/login` (exported as `imani/login`), the format is in [LOGIN_SPEC.md](LOGIN_SPEC.md), and `npm run demo:app` runs a small auction shop that uses it (it picks a free port if 8787 is taken, or use `--port <n>` or `IMANI_PORT`).

Honest limits:

- Seeing someone's sign-in payment link or QR does not let you log in as them. The site also needs a proof that only their login key can make, and it is never in the link.
- If a sign-in code is not reserved for the user's key, anyone who sees the code can pay it first with their own key and use it up. They get their own account, not the victim's, but the real user must ask for a new code. Reserving the code for the user's key stops this.
- Anyone who controls the user's device or page can make the proof. It protects against people who only see the screen.

Full list: LOGIN_SPEC.md, section 9.

## Tests

```sh
npm run test:all
npm run typecheck
```

Most examples are made-up test-network transactions built offline with throwaway keys (see `tools/gen-vectors/README.md`), and `npm run examples` rebuilds them. `examples/testnet-01` is different: a real wallet paid its 3 bids and 3 refunds on the public Zcash test network, and `--scan --fetch` reads it again live from two independent servers.

Status: early build for Zecathon, Core & Tooling track.

Licence: MIT. See THIRD_PARTY.md for the libraries used.
