# Second checker

A small second program, written in Python (standard library only), that re-works a round from the plain numbers in its two files. It was written separately from the main checker in `src/`, from the rules in `SPEC.md` and `docs/FORMAT.md`, so two programs in two languages can be compared.

```
python3 tools/second-checker/check.py                          # every case in conformance/manifest.json
python3 tools/second-checker/check.py --files disclosure.json result.json   # one round
```

It exits with a non-zero code if it disagrees with the manifest, or (with `--files`) if the round fails.

## What it does

For each case it reads `disclosure.json` and `result.json` and works out, from the amounts and block heights the files state:

- which bids are on time, and which win (item count, reserve, ties broken by earlier block then smaller id);
- the price every winner pays, under either price rule;
- what each bid is owed back, and whether the listed refunds match;
- the goal rule (reached or missed) and the sealed-lot floors on refunds;
- that the rules, the bid count, the memos and any published totals agree with each other.

It prints AGREE, NEEDS-READER or DISAGREE for each case. At the end it prints one line, for example `decided 37 of 52, agrees on all 37; the other 15 need the payment reader`.

## What it cannot do

It does not open a single shielded payment and does not read `chain.json`. It takes every amount and height as the files state them. So it can only catch a seller whose own numbers contradict each other. It cannot catch a seller whose numbers are consistent but false.

An honest round counts as "decided" when its numbers all agree. That means the arithmetic holds. It does not mean the amounts are true; only the main checker, reading the payments, can say that.

## The cases it cannot decide

On these 15 cases the numbers in the files are consistent, and the fault is only visible in the payments or on the chain. The checker says so and does not count them as decided. It does not count them as wrong either.

| Case | What only the payments or the chain show |
|---|---|
| broken/03, memo-broken/03 | A refund was never sent |
| broken/04, memo-broken/04 | A refund was sent short |
| sealed-broken/08 | A refund was never sent |
| memo-broken/07, receivers-broken/01 | A refund went to a different address |
| memo-broken/08, receivers-broken/02 | Refund addresses disagree with a bid memo |
| pricing-broken/04 | A bid the seller left out (only the chain shows it) |
| sealed-broken/03 | A seal that paid the penalty is missing from the list |
| sealed-broken/07 | The opened price differs from what the bidder opened |
| scan-broken/01 | A bid paid into the lot but left out of the files |
| scan-broken/02 | A refund paid after the refund deadline |
| scan-broken/03 | A bid shown at the wrong block height |

37 of the 52 cases are decided and the checker agrees with the manifest on all 37. It does not check 52 of 52.
