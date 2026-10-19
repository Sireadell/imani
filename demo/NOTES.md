# Design notes for the demo shop

The shop (`npm run demo:app`) shows the full path a buyer takes: sign in with a private wallet, bid on a lot, skip to the close, and check the result. These are the choices behind it.

| Choice | Why |
|---|---|
| Simulated by default, with a yellow banner | A judge can try every step in seconds without a wallet or test coins. `--live` switches to real Zcash transactions fetched by id from two public servers. |
| The same sign-in check in both modes | Simulated and live payments both reach `LoginKit.verify` as raw transaction bytes. Only the reader of those bytes changes, so the demo exercises the code a real site would run. |
| A simulated bid replays bid 2 of `examples/memo-01` | Only real transaction bytes can be read with a lot key, so the shop reuses a recorded bid (0.02 ZEC) instead of inventing one. That round's memos carry each bidder's refund address, so the lot page asks for one too. |
| No QR code | The page shows the payment link, an "Open in my wallet" button and a copy button. A QR code would need a library and its own decoder to test it against. |
| Eight broken copies to try after the close | They are the tampered rounds in `examples/memo-broken`, each failing on one named check, the same answers the command line gives. |
