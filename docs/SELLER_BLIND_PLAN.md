# Seller-blind bids: build plan

## In plain words

Today the seller holds the lot's viewing key, so the seller can read every bid the moment it lands and could slip in a fake bid just under the top one.

The fix: every bidder pays the same fixed deposit, and the bid memo holds only a sealed fingerprint of their real price (a hash, a short code that proves the price later but shows nothing now). While bidding is open the seller sees a row of equal deposits and unreadable codes. After the close each bidder sends a tiny second payment that opens their seal. Imani checks every opened price against its seal, runs the same price rule as today, and checks the refunds.

A seal that is never opened costs its owner a fixed penalty, shared out to the bidders who did open. That makes fake bids expensive for a seller who plants several and opens only the one that suits them.

| Design | Seller sees before close | Onlooker sees | Bidder never opens | Normal wallet can send it | Hours | Verdict |
|---|---|---|---|---|---|---|
| Fixed deposit plus sealed price (chosen) | Number and timing of deposits, nothing about prices | Nothing (shielded) | Bid not counted, penalty shared to openers | Yes: two ordinary payments with text memos | 16 | Chosen |
| Sealed price, real amount paid | The amount paid, which is the bid | Nothing | Same | Yes | 10 | Fails the goal: the payment itself shows the bid |
| Lot key split among referees, joined after close | Nothing, if referees are honest | Nothing | Nothing breaks | Yes | 20+ | Moves trust to referees, needs a key-splitting step no Zcash wallet does, and a referee who leaks early breaks it silently |
| Time-locked memo (price locked to a future public random beacon round) | Nothing | Nothing | Nothing breaks | No: the memo must be made by an outside tool and the result is too long and odd for wallet memo fields | 20+ | Adds an outside beacon service we would have to trust and run against |
| Zcash-only: shielded amounts and memos (ZIP 302, 512-byte memo) alone | Everything, because the seller made the key | Nothing | n/a | Yes | 0 | Shielding hides bids from the world, not from the key holder. Useful as the carrier for the chosen design, not a fix by itself |

## Why this one

| Question | Answer |
|---|---|
| What the seller learns before close | How many deposits arrived and in which blocks. Every deposit is the same amount and every memo is a 64-character code |
| What the seller learns in the opening window | Prices, as they are opened. The seller cannot add a new seal any more (late seals are not counted) |
| Leftover risk, said plainly | A seller can plant several seals before close and open only the one that suits them. Each unopened seal costs the penalty, paid to real bidders, and the check prints how many seals stayed closed |
| What an onlooker learns | Nothing new: payments are shielded |
| What still needs the lot key | Everything Imani checks, as today |
| Limit on price | A bid can never be higher than the deposit. The seller states the deposit when announcing the lot |

## The rules (SPEC.md gets a new section "Sealed lots")

1. The lot announcement adds `depositZat` (every seal pays exactly this), `forfeitZat` (penalty for an unopened seal, 0 to `depositZat`) and `openByHeight` (last block for an opening). `openByHeight` must be greater than `closeHeight` and at most `refundByHeight`.
2. A seal is a payment of exactly `depositZat` to the lot address, block at most `closeHeight`, memo `seal:<lotId>:<word>:<hash>` or `seal:<lotId>:<word>:<hash>:<refund address>`. `<hash>` is 64 lowercase hex characters.
3. `hash = sha256("imani-seal/1|" + lotId + "|" + word + "|" + amountZat + "|" + salt + "|" + refundAddressOrEmpty)`, UTF-8, hex. `amountZat` is a plain decimal integer with no leading zeros. `salt` is 32 lowercase hex characters (16 random bytes).
4. An opening is a payment of any amount above 0 to the lot address, block greater than `closeHeight` and at most `openByHeight`, memo `open:<lotId>:<word>:<amountZat>:<salt>`.
5. A seal counts as a bid of `amountZat` only when: its deposit is exactly `depositZat`, it is on time, exactly one opening for its word arrives in the window, the hash matches, and `1 <= amountZat <= depositZat`. The first opening for a word wins; later ones for the same word are replays and are refunded in full.
6. The price rule in `src/rules.ts` runs unchanged on the counted bids, with the opened amount as the bid.
7. Refund for each seal, paid in one payment with memo `refund:<lotId>:<seal txid>`:
   - counted winner: `depositZat - clearingPrice + opening amount + share`
   - counted loser: `depositZat + opening amount + share`
   - unopened, wrong hash, amount out of range, or opened late: `depositZat - forfeitZat + opening amount (if any)`
   - wrong deposit amount or late seal: everything it paid, no share, no penalty
8. `share`: the total of all penalties, split equally across counted bids, rounded down; the leftover zatoshis go to the counted bid with the lowest seal txid. With no counted bids, penalties go back to their owners (no penalty at all).
9. A replayed or late opening payment is refunded in full with memo `refund:<lotId>:<opening txid>`.

Money check: total refunds plus `clearingPrice * winners` equals everything paid in (deposits plus openings). Fee allowance stays 0.

## Files, step by step

Each step ends with `npm run typecheck` and the tests named in it passing.

| # | File | Change | Hours |
|---|---|---|---|
| 1 | `src/files.ts` | Add `SealedRules { kind: "sealed"; itemCount; reserveZat; depositZat; forfeitZat }` to the `Rules` union. Add `openByHeight?: number` to `Disclosure`. Add `sealMemoPrefix(lotId)`, `openMemoPrefix(lotId)`, `parseSealMemo(lotId, memo)` returning `{ word, hash, address? }` or null, `parseOpenMemo(lotId, memo)` returning `{ word, amountZat, salt }` or null, and `sealHash(lotId, word, amountZat, salt, address?)` using `node:crypto` sha256. Validation in `validateFiles` (in `src/check.ts`): sealed rules need `openByHeight`, `0 <= forfeitZat <= depositZat`, `reserveZat <= depositZat` | 2 |
| 2 | `src/sealed.ts` (new) | `openSeals(lotId, rules, closeHeight, openByHeight, seals, openings)` returns `{ counted: Bid[], unopened: SealFact[], badOpen: SealFact[], badDeposit: SealFact[], lateSeals, replayedOpenings, lateOpenings, owed: Map<txid, number> }`, applying rules 5, 7, 8, 9. Calls `decide()` from `src/rules.ts` for the counted bids. Pure function, no key, no I/O | 3 |
| 3 | `src/check.ts`, `keyChecks` | When `rules.kind === "sealed"`: sort lot outputs into seals (memo starts `seal:<lot>:`), openings (`open:<lot>:`), refunds, outside. Feed `openSeals`. Reuse `bid-count`, `bid-amounts` (amount is the opened amount), `no-late-bids`, `no-duplicate-bids` (seal words and opening words), `winners-and-price`, `reserve`, `refunds-paid` (owed comes from `openSeals`), `refund-receivers` (address from the seal memo), `refund-total`. Add three checks below. Non-sealed lots must take exactly the old path | 4 |
| 4 | `src/scan/*` | `scan-hidden-bids` also flags hidden seals and hidden openings (both are bid facts). Range end stays `refundByHeight`, which already covers `openByHeight` | 1 |
| 5 | `src/cli.ts` | New command `imani seal --lot <id> --amount <zat> [--address <addr>]`: prints the seal memo and saves `seal-<word>.json` with word, amount, salt (bidder keeps it). `imani open --file seal-<word>.json` prints the opening memo. No network, no key. Refuses amounts above a `--deposit` when given | 1.5 |
| 6 | `tools/make-sealed-examples.ts`, `examples/sealed-01`, `examples/sealed-broken` | Build like `tools/make-memo-examples.ts`: 2 items, reserve 1,000,000, deposit 5,000,000, forfeit 500,000, five seals: three opened honestly, one unopened, one with a wrong hash. Broken copies listed in tests below. Add `npm run examples:sealed` | 2 |
| 7 | `src/site/*`, `docs/WHO_LEARNS_WHAT.md`, `SPEC.md` | Page shows "Sealed lot: seller could not read prices before close" and the unopened count. SPEC: new section, and the "seller can see bids as they arrive" known-limit row changes to "Only in plain lots. Sealed lots hide prices until the close" | 1.5 |
| 8 | `test/tamper/matrix.test.ts` | Add `"sealed-01"` to `ROUNDS` and the new fact changes below. Locked answers 1 to 5 unchanged | 1 |

New checks (key level, only for sealed lots):

| Check id | Passes when |
|---|---|
| `seal-deposits` | Every seal paid exactly `depositZat` on time. Wrong-deposit and late seals are listed and refunded in full |
| `seal-openings` | Every counted bid has exactly one on-time opening whose hash matches its seal and whose amount is between 1 and the deposit. The seller's `bids` list holds exactly these. Message names each seal left out and why |
| `seal-forfeits` | The number of unopened or badly opened seals the seller reports (new result field `unopened: [txid]`) equals what the chain shows, and the penalty share is right. Message always prints "N seals were never opened" |

Result file additions: `unopened: string[]`, and refunds may carry `reason: "unopened"`, `"bad-opening"` or `"opening"` (for replayed or late openings).

## Tests to add (answers written before the build)

| File | Test | Expected |
|---|---|---|
| `test/sealed.test.ts` | `sealHash` on a fixed vector (lot `LOT-01`, word `q7k2`, amount 3000000, salt `00112233445566778899aabbccddeeff`, no address) | One fixed hex string, computed once and pasted in, never changed |
| same | Memo parsers: good seal, seal with address, open; reject upper-case hash, 63-char hash, amount `007`, negative amount, salt of 31 chars, wrong lot | Parsed or null as stated |
| same | `openSeals` on the sealed-01 facts | 3 counted, 1 unopened, 1 bad opening, refunds match a hand-worked table in the test file |
| same | Rounding: 3 penalties of 500,000 across 2 counted bids, and 1 zatoshi leftover case | Leftover goes to lowest seal txid |
| same | No counted bids | Nobody pays a penalty, every seal refunded in full plus opening |
| same | Opening amount above deposit, amount 0, opening at `closeHeight` (too early), at `openByHeight + 1` | Each not counted, penalty applied |
| same | Two openings for one word | First counts, second refunded in full as a replay |
| `test/check.test.ts` | sealed-01 passes; every plain example still passes with identical verdict text | PASS, old verdicts byte for byte |
| same | Seller counts an unopened seal as a bid | FAIL `seal-openings` only |
| same | Seller lists a seal opened with a wrong hash at the opened amount | FAIL `seal-openings` only |
| same | Seller hides an unopened seal from `unopened` | FAIL `seal-forfeits` only |
| same | Seller keeps the penalty instead of sharing it | FAIL `refunds-paid` and `refund-total` |
| same | Seller counts a seal with deposit 4,999,999 | FAIL `seal-deposits` only |
| `test/tamper/matrix.test.ts` | Every one-fact change on sealed-01 (amount, height, salt digit, word, deposit, forfeit, openByHeight, each refund) | Never PASS |
| `test/scan/*` | Seller leaves one opening out of the disclosure | FAIL `scan-hidden-bids`, names the opening |
| `test/cli` (existing CLI test file) | `imani seal` then `imani open` round-trip; hash re-computes; no network contacted | Matches; "Servers contacted: none" |
| `test/leak.test.ts` | The seal file's salt never appears in a `--discreet` verdict | Not present |

## Real-wallet check (do once by hand before calling it done)

Send one seal and one opening from a normal test-network wallet (for example Zashi or Zingo) by pasting the two memos from `imani seal` and `imani open`. Confirm both memos arrive whole (a seal memo with a unified address is under 300 bytes, inside the 512-byte memo limit of ZIP 302) and that `imani check` reads them. Record the two txids in `docs/HOW_WE_TESTED.md`.

## Out of scope

Hiding the number of bidders from the seller, and stopping a seller who is willing to pay the penalty on planted seals. Both stay listed in SPEC.md known limits, in those words.

Total: about 16 hours.
