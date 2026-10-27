# Bid by wallet: `imani bid-link`

A bidder should not have to copy an address, an amount and a memo by hand. `imani bid-link` turns a bid into a Zcash payment request ([ZIP 321](https://zips.z.cash/zip-0321)): a `zcash:` link and a QR code. A wallet that reads payment requests fills in the lot address, the amount and the bid memo when you scan it or open it.

```
imani bid-link --lot LOT-01 --address <lot address> --amount-zat 3000000 --refund-address <your address> --svg bid.svg
```

| What | How it works |
|---|---|
| Link | `zcash:<lot address>?amount=<ZEC>&memo=<memo>`. The amount is decimal ZEC with at most 8 digits after the period. The memo is base64url with no padding, 512 bytes at most. Both rules are from ZIP 321 |
| Memo | `bid:<lot>:<your code>`, or `bid:<lot>:<your code>:<refund address>` when you give `--refund-address`. This is the same memo the checker reads, so a bid made from the link is counted like any other. `--memo` uses a memo you made yourself, for example a sealed bid's seal memo |
| Raising a bid | When a lot allows top-ups, paying again with exactly the same memo before the close adds to your bid. Keep your bid code |
| QR code | Printed as text in the terminal, and saved as a picture with `--svg`. The same builder runs on the checker page ("Bid from your wallet") |
| Safety | It only builds text. It sends nothing, contacts no server and uses no key. A transparent address is refused, because a memo cannot go to one |

How it is tested: `test/bidlink.test.ts` reads the link back with a small parser written from the ZIP 321 grammar, and scans the QR code with an independent reader (jsQR) to check it returns exactly the link.

Tested by hand once: a mainnet QR scanned with the ZODL wallet, which read it. A testnet link did nothing in that wallet. What is not tested: other wallets, and a paid bid checked end to end. A wallet may show the memo differently or ignore a field it does not support, so check the amount, address and memo your wallet shows before you send.
