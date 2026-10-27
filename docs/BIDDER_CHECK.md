# Bidder check: "was my bid counted and is my refund right", with no help from the seller

`imani bidder-check` is for one bidder. It needs three things the bidder already has or can get: their own viewing key (read-only, from their wallet), the lot's public facts (published before the auction), and public chain data. It does not need the seller's disclosure file or the lot key.

```sh
npx @sireadell/imani bidder-check --facts lot-public.json --key-file my-viewing-key.txt --fetch --bid <txid>:<zatoshis you paid>
```

| Input | What it is |
|---|---|
| `--facts` | `imani-lot-public/1`: lot id, network, open, close and refund-deadline heights. Optional: `reserveZat`, `lotAddress`. Example: `examples/bidder-01/lot-public.json` |
| `--key-file` | Your own unified full viewing key, as plain text (or JSON with a `ufvk` field). A spending key or seed phrase is refused. It is never printed and never sent anywhere |
| `--bid <txid>[:<zat>]` | Your bid's transaction id, and the amount your wallet shows you paid. Repeat for more bids. If your key can read its own outgoing payment, you can leave `--bid` out and the check finds your bids itself |
| `--chain <file>` or `--fetch` | Where the blocks come from: a saved chain file (offline), or two public servers run by different operators that must agree on every block and every transaction. Your key is never sent: only block heights are asked for |
| `--result <file>` | Optional: the seller's published result, to compare with it as well |

Exit codes: 0 PASS, 1 FAIL, 3 NOT PROVEN (nothing wrong found, but your key alone cannot settle it), 2 refused or bad input.

## What it checks

| Line | Meaning |
|---|---|
| Landed | Your bid payment is in a block, at a height read from the chain (not the seller), inside the open to close window or not |
| Paid | Your key reads its own outgoing payment: amount, and the lot address if the facts list it. If your wallet does not keep the sender view, the amount is `GIVEN` (your word) and the line says so |
| Refund | The payments to your wallet carrying the memo `refund:<lot>:<your bid txid>`, with heights and amounts. Whole bid back, bid minus a price at or above the reserve, short, more than the bid, or late (after the deadline, found by also reading 10 blocks past it) |
| With `--result` | Your bid is in the seller's counted list (or correctly left out if late), the seller's refund amount equals what reached you, and the price the seller states for you matches your refund |

## What a bidder alone can and cannot prove

| Can prove | Cannot prove |
|---|---|
| Your bid payment landed, and when | What the other bids were, so the clearing price is never confirmed from your key. A winner sees the price they paid and that it is within their bid and not below the reserve |
| The refunds that reached your wallet, with amounts and heights | Whether you won. A whole-bid refund fits losing, a smaller refund fits winning. No refund fits winning at your full bid or a refund never paid, so that is `NOT PROVEN`, never `PASS` |
| That a refund was late, short against your bid, or more than your bid | That the seller counted your bid in their result, unless you pass `--result` |

The printed report always ends with these limits.

## Works with `--fetch` from two servers

`--fetch` uses the same download as the full checker: a light server and an explorer from different operators must return identical bytes for every transaction or the run stops. On the Zcash test network this works today (`testnet.zec.rocks` and the Cipherscan testnet explorer). A run from the lot's open height to the deadline plus 10 blocks reads those blocks only. Your key stays on your machine.

## Tested

`test/bidder.test.ts`: honest losing, winning and late bidders pass offline. Tampered cases fail: bid not on the chain, bid moved past the close, short refund, refund below the reserve, late refund, no refund (NOT PROVEN), refund bigger than the bid, a missing block, a seller result that leaves the bid out or states the wrong refund. A spending key, a seed phrase and a wrong-network key are refused.

## Real round

`examples/testnet-01` is a real round on the Zcash test network (lot DRY-01). The public part, that a bid is on the chain inside the window, was run on the real blocks both offline and with `--fetch`. The refund line needs the bidder wallet's own viewing key, which lives in the wallet that paid the 3 bids and is not published.

## README lines to add (for the page owner)

- Command list: `imani bidder-check --facts lot-public.json --key-file my-viewing-key.txt --fetch --bid <txid>:<amount>`, "a bidder confirms their bid landed and their refund is right with only their own viewing key and public chain data. No seller file."
- Limits line: "Alone, a bidder cannot confirm the clearing price or whether they won: the report says NOT PROVEN there. Add the seller's published result to compare."
- Link to `docs/BIDDER_CHECK.md`.
