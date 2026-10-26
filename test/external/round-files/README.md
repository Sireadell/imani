Files in this folder come from ShieldBid (https://github.com/Jacksoxx/shieldbid), MIT licence,
copyright (c) 2026 Qihao Xiao. The licence text is in LICENSE-shieldbid.

- `reveal.json` and `tampered.json` are `lots/DEMO/` as published, byte for byte. They are a made-up round with made-up transaction ids.
- `demo01-settlement.json` is `docs/demo_01_settlement.json` cut down to the fields imani reads (no salts, no commits, no refund address). The amounts and transaction ids are as published.
- `demo01-chain.json` is a saved copy of the three real mainnet transactions listed in `demo01-settlement.json`, fetched on 2026-10-26 from two servers run by different operators (zec.rocks and cakewallet.com). It lets `npm run check:external -- test/external/round-files/demo01-settlement.json --chain test/external/round-files/demo01-chain.json` run offline. The transactions are public chain data and the bytes are re-hashed on every read.
