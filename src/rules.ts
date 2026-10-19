import type { AuctionRules, GoalRules, Rules } from "./files.ts";

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
 * 3. Every winner pays the same clearing price: the highest bid that did not win, but never less
 *    than the reserve. If every bid wins, the clearing price is the reserve.
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

function decideAuction(bids: Bid[], rules: AuctionRules): Outcome {
  const ranked = [...bids].sort(
    (a, b) => b.amountZat - a.amountZat || a.height - b.height || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0),
  );
  const eligible = ranked.filter((b) => b.amountZat >= rules.reserveZat);
  const winning = eligible.slice(0, rules.itemCount);
  const winnerIds = new Set(winning.map((b) => b.txid));
  const reserveMet = winning.length > 0;
  const highestLoser = ranked.find((b) => !winnerIds.has(b.txid));
  const clearingPriceZat = reserveMet ? Math.max(rules.reserveZat, highestLoser?.amountZat ?? 0) : 0;
  const refundsOwed = new Map<string, number>();
  for (const b of ranked) {
    refundsOwed.set(b.txid, winnerIds.has(b.txid) ? b.amountZat - clearingPriceZat : b.amountZat);
  }
  return { reserveMet, winners: winning.map((b) => b.txid), clearingPriceZat, refundsOwed };
}
