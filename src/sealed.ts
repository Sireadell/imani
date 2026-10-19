// Sealed lots: the pure rules for seals, openings, penalties and refunds. No key, no I/O.
// See SPEC.md "Sealed lots".
import { decide, type Bid, type Outcome } from "./rules.ts";
import { sealHash, type RefundReason, type SealedRules } from "./files.ts";

/** A payment into the lot address whose memo starts with `seal:<lot>:`. */
export interface SealFact {
  txid: string;
  height: number;
  /** What the payment carried, in zatoshis. */
  paidZat: number;
  /** False when the memo is not a well-formed seal. Such a payment is refunded in full. */
  valid: boolean;
  word: string;
  hash: string;
  /** Refund address written inside the seal memo, if any. */
  address: string | null;
}

/** A payment into the lot address whose memo starts with `open:<lot>:`. */
export interface OpenFact {
  txid: string;
  height: number;
  paidZat: number;
  /** False when the memo is not a well-formed opening. Such a payment is refunded in full. */
  valid: boolean;
  word: string;
  amountZat: number;
  salt: string;
}

export interface SealedOutcome {
  /** Seals that count as bids, with the opened price as the bid amount. */
  counted: Bid[];
  /** On-time seals with no opening in the window. */
  unopened: SealFact[];
  /** On-time seals whose opening arrived but did not match (wrong hash, or price out of range). */
  badOpen: SealFact[];
  /** Seals that paid the wrong deposit, or whose memo is malformed. Refunded in full. */
  badDeposit: SealFact[];
  /** Seals that arrived after the close. Refunded in full. */
  lateSeals: SealFact[];
  /** A second correct seal for a word already sealed. Refunded in full. */
  replayedSeals: SealFact[];
  /** A second opening in the window for a word already opened. Refunded in full. */
  replayedOpenings: OpenFact[];
  /** Openings outside the window, with a malformed memo, or for a word with no valid seal. Refunded in full. */
  strayOpenings: OpenFact[];
  /** The opening payment that belongs to each on-time seal (by seal txid), when one arrived. */
  openingOf: Map<string, OpenFact>;
  /** Total of the penalties, and what each counted bid gets (rounded down) plus the leftover for the lowest seal txid. */
  penaltyTotal: number;
  share: number;
  leftover: number;
  leftoverTo: string | null;
  outcome: Outcome;
  /** What each payment is owed back, keyed by seal txid (or by opening txid for the openings above). */
  owed: Map<string, number>;
  reasons: Map<string, RefundReason>;
}

const lowerTxid = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byHeightThenTxid = <T extends { height: number; txid: string }>(a: T, b: T) => a.height - b.height || lowerTxid(a.txid, b.txid);

/**
 * Work out which seals count, which are penalised, and what every payment is owed back.
 * Rules 5, 7, 8 and 9 of the sealed-lot plan. The price rule itself is `decide()` in rules.ts.
 */
export function openSeals(
  lotId: string,
  rules: SealedRules,
  closeHeight: number,
  openByHeight: number,
  seals: SealFact[],
  openings: OpenFact[],
): SealedOutcome {
  const badDeposit: SealFact[] = [];
  const lateSeals: SealFact[] = [];
  const replayedSeals: SealFact[] = [];
  const eligible: SealFact[] = [];
  const sealedWords = new Set<string>();
  for (const s of [...seals].sort(byHeightThenTxid)) {
    if (!s.valid || s.paidZat !== rules.depositZat) badDeposit.push(s);
    else if (s.height > closeHeight) lateSeals.push(s);
    else if (sealedWords.has(s.word)) replayedSeals.push(s);
    else {
      sealedWords.add(s.word);
      eligible.push(s);
    }
  }
  const sealOfWord = new Map(eligible.map((s) => [s.word, s]));
  const sealById = new Map(eligible.map((s) => [s.txid, s]));

  // Openings: the first one in the window for a word is the opening, the rest are replays.
  const strayOpenings: OpenFact[] = [];
  const replayedOpenings: OpenFact[] = [];
  const openingOf = new Map<string, OpenFact>();
  for (const o of [...openings].sort(byHeightThenTxid)) {
    const inWindow = o.height > closeHeight && o.height <= openByHeight;
    const seal = o.valid ? sealOfWord.get(o.word) : undefined;
    if (!o.valid || !inWindow || !seal) strayOpenings.push(o);
    else if (openingOf.has(seal.txid)) replayedOpenings.push(o);
    else openingOf.set(seal.txid, o);
  }

  const counted: Bid[] = [];
  const unopened: SealFact[] = [];
  const badOpen: SealFact[] = [];
  for (const s of eligible) {
    const o = openingOf.get(s.txid);
    if (!o) {
      unopened.push(s);
      continue;
    }
    const inRange = Number.isSafeInteger(o.amountZat) && o.amountZat >= 1 && o.amountZat <= rules.depositZat;
    if (inRange && sealHash(lotId, s.word, o.amountZat, o.salt, s.address) === s.hash) {
      counted.push({ txid: s.txid, amountZat: o.amountZat, height: s.height });
    } else {
      badOpen.push(s);
    }
  }

  const outcome = decide(counted, { kind: "auction", itemCount: rules.itemCount, reserveZat: rules.reserveZat });

  // Penalties are only charged when someone opened correctly to receive them.
  const penalised = counted.length ? [...unopened, ...badOpen] : [];
  const penaltyTotal = penalised.length * rules.forfeitZat;
  const share = counted.length ? Math.floor(penaltyTotal / counted.length) : 0;
  const leftover = counted.length ? penaltyTotal - share * counted.length : 0;
  const leftoverTo = counted.length ? counted.map((b) => b.txid).sort(lowerTxid)[0] : null;
  const winnerIds = new Set(outcome.winners);

  const owed = new Map<string, number>();
  const reasons = new Map<string, RefundReason>();
  const set = (id: string, amount: number, reason: RefundReason) => {
    owed.set(id, amount);
    reasons.set(id, reason);
  };
  const openPaid = (s: SealFact) => openingOf.get(s.txid)?.paidZat ?? 0;
  for (const b of counted) {
    const s = sealById.get(b.txid)!;
    const won = winnerIds.has(b.txid);
    set(b.txid, rules.depositZat - (won ? outcome.clearingPriceZat : 0) + openPaid(s) + share + (b.txid === leftoverTo ? leftover : 0), won ? "change" : "loser");
  }
  for (const s of unopened) set(s.txid, rules.depositZat - (counted.length ? rules.forfeitZat : 0), "unopened");
  for (const s of badOpen) set(s.txid, rules.depositZat - (counted.length ? rules.forfeitZat : 0) + openPaid(s), "bad-opening");
  for (const s of [...badDeposit, ...lateSeals, ...replayedSeals]) set(s.txid, s.paidZat, "late");
  for (const o of [...replayedOpenings, ...strayOpenings]) set(o.txid, o.paidZat, "opening");

  return {
    counted,
    unopened,
    badOpen,
    badDeposit,
    lateSeals,
    replayedSeals,
    replayedOpenings,
    strayOpenings,
    openingOf,
    penaltyTotal,
    share,
    leftover,
    leftoverTo,
    outcome,
    owed,
    reasons,
  };
}
