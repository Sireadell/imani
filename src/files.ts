// File formats for the auction checker. See SPEC.md for the plain-language description.

/** One transaction the seller discloses for a lot. */
export interface DisclosedTx {
  txid: string;
  /** Block height the transaction was mined at, as stated by the seller. */
  height: number;
  txHex: string;
}

/** Lot disclosure file, published by the seller after the auction closes. */
export interface Disclosure {
  format: "imani-lot-disclosure/1";
  lotId: string;
  network: "main" | "test";
  /** Last block height at which a bid still counts. */
  closeHeight: number;
  /** First block height at which a bid counts. Needed only for the scan level. */
  openHeight?: number;
  /** Last block height by which every refund is paid. Needed only for the scan level. */
  refundByHeight?: number;
  rules: AuctionRules;
  /** One-time read-only key for this lot (uview1... or uviewtest1...). Optional: without it only the basic level runs. */
  ufvk?: string;
  transactions: DisclosedTx[];
  /**
   * Optional. The address each bid's refund must go to, one entry per bid. When present, the
   * checker requires every refund to arrive at the address listed for its bid.
   */
  refundAddresses?: RefundAddress[];
}

export interface RefundAddress {
  bidTxid: string;
  /** Unified (u1... / utest1...) or Sapling address the bidder wants the refund sent to. */
  address: string;
}

export interface AuctionRules {
  /** Number of identical items sold in the lot. */
  itemCount: number;
  /** Lowest price the seller accepts, in zatoshis (1 ZEC = 100,000,000 zatoshis). */
  reserveZat: number;
}

export type RefundReason = "loser" | "change" | "late";

export interface SellerRefund {
  bidTxid: string;
  amountZat: number;
  reason: RefundReason;
  /** Memo the refund carries: "refund:<lotId>:<bidTxid>". */
  memo: string;
}

/** Seller result file: what the seller says happened. */
export interface SellerResult {
  format: "imani-lot-result/1";
  lotId: string;
  rules: AuctionRules;
  bidCount: number;
  bids: { txid: string; amountZat: number }[];
  winners: string[];
  clearingPriceZat: number;
  reserveMet: boolean;
  refunds: SellerRefund[];
}

export const bidMemoPrefix = (lotId: string) => `bid:${lotId}:`;
export const refundMemo = (lotId: string, bidTxid: string) => `refund:${lotId}:${bidTxid}`;
export const refundMemoPrefix = (lotId: string) => `refund:${lotId}:`;

/**
 * A bid memo is `bid:<lotId>:<word>`, or `bid:<lotId>:<word>:<refund address>`. The address is
 * written by the bidder inside their own payment, so the lot key reads it from the chain and the
 * seller cannot choose it. Returns null when the memo has no address part.
 */
export function bidMemoAddress(lotId: string, memo: string): string | null {
  const prefix = bidMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const rest = memo.slice(prefix.length);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  const address = rest.slice(cut + 1).trim();
  return address === "" ? null : address;
}
