import { createHash } from "node:crypto";

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
  /** Sealed lots only: last block height at which a seal can still be opened. */
  openByHeight?: number;
  rules: Rules;
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

/** The rule a lot runs under: the uniform price auction (the default) or an all-or-nothing goal. */
export type Rules = AuctionRules | GoalRules | SealedRules;

/**
 * All-or-nothing collection (fundraiser, group buy). If the on-time payments add up to the goal,
 * every one of them is kept and nobody is refunded. If they fall short, every payment is refunded
 * in full. Payments after the close are always refunded in full.
 */
export interface GoalRules {
  kind: "goal";
  /** Total the on-time payments must reach, in zatoshis. */
  goalZat: number;
}

export interface AuctionRules {
  kind?: "auction";
  /** Number of identical items sold in the lot. */
  itemCount: number;
  /** Lowest price the seller accepts, in zatoshis (1 ZEC = 100,000,000 zatoshis). */
  reserveZat: number;
  /**
   * What every winner pays. "highest-losing" (the default): the highest bid that did not win, never below the reserve.
   * "lowest-winning": the lowest bid that won, so the last bidder in pays exactly what they bid.
   */
  pricing?: PricingRule;
  /**
   * When true, a bidder may pay again before the close with the same bid memo to raise their bid. All their on-time
   * payments under that memo are added up and count as one bid. When false or missing, a repeated memo is a replay.
   */
  topUps?: boolean;
}

export type PricingRule = "highest-losing" | "lowest-winning";

/**
 * Sealed lot: every bidder pays the same fixed deposit with only a hash of the price in the memo,
 * then opens the price after the close. The price rule is the uniform price rule on the opened prices.
 */
export interface SealedRules {
  kind: "sealed";
  itemCount: number;
  reserveZat: number;
  /** Every seal pays exactly this, in zatoshis. A price can never be higher than the deposit. */
  depositZat: number;
  /** Penalty for a seal that is not opened correctly, 0 to depositZat. Shared to the bidders who opened. */
  forfeitZat: number;
}

export type RefundReason = "loser" | "change" | "late" | "unopened" | "bad-opening" | "opening";

export interface SellerRefund {
  bidTxid: string;
  amountZat: number;
  reason: RefundReason;
  /** Memo the refund carries: "refund:<lotId>:<bidTxid>". */
  memo: string;
}

/**
 * The headline numbers a seller publishes next to a round, so anyone can add them up.
 * `payments` is every bid payment that reached the lot (late and repeated ones too, seals for a sealed lot),
 * `receivedZat` their sum, `keptZat` what the seller keeps (winners' payments), `refundedZat` what was paid back.
 * The money rule: received = kept + refunded, with no fees taken from bidders.
 */
export interface PublishedTotals {
  payments: number;
  receivedZat: number;
  keptZat: number;
  refundedZat: number;
}

/** Seller result file: what the seller says happened. */
export interface SellerResult {
  format: "imani-lot-result/1";
  lotId: string;
  rules: Rules;
  bidCount: number;
  bids: { txid: string; amountZat: number }[];
  winners: string[];
  clearingPriceZat: number;
  reserveMet: boolean;
  refunds: SellerRefund[];
  /** Sealed lots only: seals never opened or opened wrongly (they paid the penalty). */
  unopened?: string[];
  /** Optional headline numbers. When present, the checker adds them up and compares them with the chain. */
  totals?: PublishedTotals;
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

export const sealMemoPrefix = (lotId: string) => `seal:${lotId}:`;
export const openMemoPrefix = (lotId: string) => `open:${lotId}:`;

const WORD = /^[A-Za-z0-9]{1,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{32}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,15})$/;

/**
 * A seal memo is `seal:<lotId>:<word>:<hash>` or `seal:<lotId>:<word>:<hash>:<refund address>`.
 * Returns null when the memo is not a well-formed seal for this lot.
 */
export function parseSealMemo(lotId: string, memo: string): { word: string; hash: string; address: string | null } | null {
  const prefix = sealMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const parts = memo.slice(prefix.length).split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [word, hash, address] = parts;
  if (!WORD.test(word) || !HASH.test(hash)) return null;
  if (parts.length === 3 && address.trim() === "") return null;
  return { word, hash, address: parts.length === 3 ? address.trim() : null };
}

/** An opening memo is `open:<lotId>:<word>:<amountZat>:<salt>`. Returns null when it is not well formed. */
export function parseOpenMemo(lotId: string, memo: string): { word: string; amountZat: number; salt: string } | null {
  const prefix = openMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const parts = memo.slice(prefix.length).split(":");
  if (parts.length !== 3) return null;
  const [word, amount, salt] = parts;
  if (!WORD.test(word) || !AMOUNT.test(amount) || !SALT.test(salt)) return null;
  return { word, amountZat: Number(amount), salt };
}

/** sha256("imani-seal/1|" + lotId + "|" + word + "|" + amountZat + "|" + salt + "|" + refundAddressOrEmpty), hex. */
export function sealHash(lotId: string, word: string, amountZat: number, salt: string, address?: string | null): string {
  return createHash("sha256").update(`imani-seal/1|${lotId}|${word}|${amountZat}|${salt}|${address ?? ""}`, "utf8").digest("hex");
}
