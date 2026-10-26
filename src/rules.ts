import type { AuctionRules, GoalRules, Rules, SealedRules } from "./files.ts";

export interface Bid {
  txid: string;
  amountZat: number;
  height: number;
}

export interface Outcome {
  reserveMet: boolean;
  winners: string[];
  clearingPriceZat: number;
  /** What each counted bid gets back: losers their whole bid, winners their bid minus the clearing price. */
  refundsOwed: Map<string, number>;
}

/**
 * The uniform price rule used by imani lots.
 * 1. Rank bids from highest to lowest. Equal amounts: earlier block height first, then lower txid.
 * 2. Only bids at or above the reserve can win. The top `itemCount` of those win, one item each.
 * 3. Every winner pays the same clearing price. By default ("highest-losing") that is the highest bid that
 *    did not win, but never less than the reserve; if every bid wins, it is the reserve. With
 *    pricing "lowest-winning" it is the lowest bid that won (never below the reserve, since every winner
 *    is at or above it).
 * 4. Winners get back their bid minus the clearing price. Losers get back their whole bid.
 * 5. If no bid reaches the reserve, there are no winners, the clearing price is 0, and every bid is refunded.
 */
export function decide(bids: Bid[], rules: Rules): Outcome {
  return rules.kind === "goal" ? decideGoal(bids, rules) : decideAuction(bids, rules);
}

/**
 * The goal rule. If the payments add up to the goal, every payment is counted and kept, nothing is
 * refunded, and there is no price (0). If they fall short there are no winners and every payment
 * is refunded in full.
 */
function decideGoal(bids: Bid[], rules: GoalRules): Outcome {
  const total = bids.reduce((s, b) => s + b.amountZat, 0);
  const reached = bids.length > 0 && total >= rules.goalZat;
  const refundsOwed = new Map<string, number>();
  for (const b of bids) refundsOwed.set(b.txid, reached ? 0 : b.amountZat);
  return { reserveMet: reached, winners: reached ? bids.map((b) => b.txid) : [], clearingPriceZat: 0, refundsOwed };
}

function decideAuction(bids: Bid[], rules: AuctionRules | SealedRules): Outcome {
  const ranked = [...bids].sort(
    (a, b) => b.amountZat - a.amountZat || a.height - b.height || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0),
  );
  const eligible = ranked.filter((b) => b.amountZat >= rules.reserveZat);
  const winning = eligible.slice(0, rules.itemCount);
  const winnerIds = new Set(winning.map((b) => b.txid));
  const reserveMet = winning.length > 0;
  const highestLoser = ranked.find((b) => !winnerIds.has(b.txid));
  const lowestWinner = winning[winning.length - 1];
  const clearingPriceZat = !reserveMet
    ? 0
    : (rules as AuctionRules).pricing === "lowest-winning"
      ? Math.max(rules.reserveZat, lowestWinner.amountZat)
      : Math.max(rules.reserveZat, highestLoser?.amountZat ?? 0);
  const refundsOwed = new Map<string, number>();
  for (const b of ranked) {
    refundsOwed.set(b.txid, winnerIds.has(b.txid) ? b.amountZat - clearingPriceZat : b.amountZat);
  }
  return { reserveMet, winners: winning.map((b) => b.txid), clearingPriceZat, refundsOwed };
}

/** A payment into the lot with a bid memo, as read from the chain (one per transaction). */
export interface BidPayment extends Bid {
  memo: string;
  outputs: number;
}

/**
 * Turns the bid payments the lot key sees into bids.
 * Default: the first payment under a memo is the bid and any later payment under the same memo is a
 * replay (it is not a new bid and is owed back in full).
 * With `topUps`: all payments under one memo that arrive by the close are added up into one bid. The bid
 * is identified by its first payment, its amount is the sum, and its block is the block of the last
 * payment that counted (so a bidder who tops up ranks behind an equal bid placed earlier). A payment
 * after the close is never added: it stands alone as a late bid and is owed back in full.
 * Input must be sorted by block height, then txid.
 */
export function groupBidPayments<T extends BidPayment>(sorted: T[], topUps: boolean, closeHeight: number): { bids: T[]; replays: T[] } {
  if (!topUps) {
    const first = new Map<string, T>();
    const replays: T[] = [];
    for (const b of sorted) {
      if (first.has(b.memo)) replays.push(b);
      else first.set(b.memo, b);
    }
    return { bids: [...first.values()], replays };
  }
  const merged = new Map<string, T>();
  const bids: T[] = [];
  for (const b of sorted) {
    if (b.height > closeHeight) {
      bids.push(b);
      continue;
    }
    const m = merged.get(b.memo);
    if (!m) {
      const copy = { ...b };
      merged.set(b.memo, copy);
      bids.push(copy);
    } else {
      m.amountZat += b.amountZat;
      m.height = b.height;
      m.outputs = Math.max(m.outputs, b.outputs);
    }
  }
  return { bids, replays: [] };
}
