# bidder-01: a bidder checks their own bid, no seller file

Same offline round as `scan-01` (lot LOT-01), seen by each bidder with only their own throwaway test key. The keys hold nothing.

```sh
npx @sireadell/imani bidder-check --facts examples/bidder-01/lot-public.json --key-file examples/bidder-01/carol.key --chain examples/scan-01/chain.json --bid e0656c882730bbc466afa80f0cd07c0caa8a5c2dc74132190c16ff965d8d426c:1500000
```

| Key file | Bid | Expected |
|---|---|---|
| `alice.key` | `d928588f...:3000000` | PASS, won, paid 1,500,000 |
| `bob.key` | `43e9e39e...:2000000` | PASS, won, paid 1,500,000 |
| `carol.key` | `e0656c88...:1500000` | PASS, lost, refunded in full |
| `dave.key` | `ab867ef0...:1200000` | PASS, late bid, refunded in full |

Full txids are in `examples/scan-01/bidder-keys.json`. See `docs/BIDDER_CHECK.md`.
