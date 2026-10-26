// Referee mode: check a sealed-bid round with only the lot's viewing key and a block range.
// There is no seller file to compare with, so the files a seller would publish are rebuilt from
// the chain itself: every payment the key sees, then the winners, price and refunds the rules
// give. Those two rebuilt files go through the same checkLot as every other check, unchanged.
// What this proves: the refunds the lot really paid are exactly what the rules owe, with no
// stray payment in the key's view. What it cannot prove: that no bid was hidden from the key.
// Pure functions, no network: the page (or a test) hands in the blocks.
import { assertViewingKey, checkLot, InputError, KeyRefusedError, type Verdict } from "../check.ts";
import { bidMemoPrefix, refundMemo, type Disclosure, type SellerRefund, type SellerResult } from "../files.ts";
import { readTransactionWithId, type ReadOutput } from "../read.ts";
import { decide, groupBidPayments, type BidPayment } from "../rules.ts";
import type { PricingRule } from "../files.ts";
import { ScanInputError, type BlockSource, type ChainBlock } from "../scan/chain.ts";

export interface RefereeInput {
  /** The lot's read-only viewing key (uview1... or uviewtest1...). */
  key: string;
  from: number;
  to: number;
  itemCount: number;
  reserveZat: number;
  /** What winners pay. Default "highest-losing". */
  pricing?: PricingRule;
  /** True when bidders may raise a bid by paying again with the same memo before the close. */
  topUps?: boolean;
  /** Last block at which a bid counts. Default: the last block of the range. */
  closeHeight?: number;
  /** Needed only when the key sees bids for more than one lot name. */
  lotId?: string;
  blocks: ChainBlock[];
  /** Heights in the range that could not be fetched. */
  missing: number[];
  source: BlockSource;
}

export interface RefereeRound {
  lotId: string;
  bidCount: number;
  lateBids: number;
  winners: { txid: string; amountZat: number; paysZat: number; refundZat: number }[];
  clearingPriceZat: number;
  /** The price rule and the top-up setting the round was checked under. */
  pricing: PricingRule;
  topUps: boolean;
  reserveMet: boolean;
  losers: { txid: string; amountZat: number }[];
  /** What the chain shows was refunded, per bid, next to what the rules owe. */
  refunds: { bidTxid: string; owedZat: number; paidZat: number }[];
}

export type RefereeOutcome =
  | { ok: true; verdict: Verdict; round: RefereeRound; closeAssumed: boolean }
  | { ok: false; kind: "refused" | "input" | "error"; message: string };

const MAX_RANGE = 5000;

function validateInput(i: RefereeInput): void {
  const bad = (m: string): never => {
    throw new InputError(`Input error: ${m}`);
  };
  if (!Number.isSafeInteger(i.from) || i.from < 1 || !Number.isSafeInteger(i.to) || i.to < i.from) bad("the block range must be two whole numbers, the first not after the last.");
  if (i.to - i.from + 1 > MAX_RANGE) bad(`the range is more than ${MAX_RANGE} blocks. Check the open block and the last refund block of the round.`);
  if (!Number.isSafeInteger(i.itemCount) || i.itemCount < 1) bad("the number of items must be a whole number, 1 or more.");
  if (!Number.isSafeInteger(i.reserveZat) || i.reserveZat < 0) bad("the reserve must be a whole number of zatoshis (1 ZEC = 100,000,000), 0 or more.");
  if (i.pricing !== undefined && i.pricing !== "highest-losing" && i.pricing !== "lowest-winning") bad('the price rule must be "highest-losing" or "lowest-winning".');
  if (i.closeHeight !== undefined && (!Number.isSafeInteger(i.closeHeight) || i.closeHeight < i.from || i.closeHeight > i.to)) bad("the close block must be inside the block range.");
  if (i.lotId !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(i.lotId)) bad("the lot name must be 1 to 40 letters, digits, dots, dashes or underscores.");
}

/** Which network a viewing key belongs to, from its first letters. */
export function networkOfKey(key: string): "main" | "test" {
  return key.trim().startsWith("uviewtest1") ? "test" : "main";
}

interface Seen {
  txid: string;
  txHex: string;
  height: number;
  outputs: ReadOutput[];
}

const BID_MEMO = /^bid:([A-Za-z0-9._-]{1,40}):/;

/** Rebuild the seller's two files from the chain and run the checker over them. */
export function refereeRound(i: RefereeInput): RefereeOutcome {
  try {
    validateInput(i);
    const network = networkOfKey(i.key);
    const key = assertViewingKey(i.key, network);
    const closeAssumed = i.closeHeight === undefined;
    const closeHeight = i.closeHeight ?? i.to;

    // Read every transaction of every block with the key.
    const seen: Seen[] = [];
    for (const b of [...i.blocks].sort((a, c) => a.height - c.height)) {
      if (b.height < i.from || b.height > i.to) continue;
      for (const t of b.txs) {
        let res;
        try {
          res = readTransactionWithId(t.txHex, key);
        } catch {
          continue; // the scan inside checkLot reports every unreadable transaction
        }
        if (res.txid !== t.txid.toLowerCase()) continue; // reported by the scan as well
        seen.push({ txid: res.txid, txHex: t.txHex, height: b.height, outputs: res.outputs });
      }
    }
    const visible = seen.filter((x) => x.outputs.some((o) => o.transferType !== "internal"));

    // The lot name is whatever the bids' memos say.
    const names = new Set<string>();
    for (const x of visible) for (const o of x.outputs) if (o.transferType === "incoming") {
      const m = BID_MEMO.exec(o.memo);
      if (m) names.add(m[1]);
    }
    let lotId = i.lotId;
    if (lotId === undefined) {
      if (names.size === 0) throw new InputError("Input error: the key sees no bid in these blocks (a bid carries a memo that starts with bid:<lot name>:). Check the key and the block range.");
      if (names.size > 1) throw new InputError(`Input error: the key sees bids for more than one lot name (${[...names].sort().join(", ")}). Fill in the lot name.`);
      lotId = [...names][0];
    } else if (!names.has(lotId)) {
      throw new InputError(`Input error: the key sees no bid for lot ${lotId} in these blocks.`);
    }

    // Bids as checkLot counts them: first use of a memo, on time. Later uses are replays.
    const prefix = bidMemoPrefix(lotId);
    const bidTx = new Map<string, BidPayment>();
    for (const x of visible) {
      for (const o of x.outputs) {
        if (o.transferType !== "incoming" || !o.memo.startsWith(prefix)) continue;
        const prev = bidTx.get(x.txid);
        if (prev) {
          prev.amountZat += o.amountZat;
          prev.outputs += 1;
        } else bidTx.set(x.txid, { txid: x.txid, amountZat: o.amountZat, height: x.height, memo: o.memo, outputs: 1 });
      }
    }
    const grouped = groupBidPayments([...bidTx.values()].sort((a, c) => a.height - c.height || (a.txid < c.txid ? -1 : 1)), i.topUps === true, closeHeight);
    const replays = grouped.replays;
    const all = grouped.bids;
    const onTime = all.filter((b) => b.height <= closeHeight);
    const late = all.filter((b) => b.height > closeHeight);

    const rules = {
      itemCount: i.itemCount,
      reserveZat: i.reserveZat,
      ...(i.pricing && i.pricing !== "highest-losing" ? { pricing: i.pricing } : {}),
      ...(i.topUps ? { topUps: true } : {}),
    };
    const outcome = decide(onTime, rules);
    const winnerSet = new Set(outcome.winners);
    const refunds: SellerRefund[] = [];
    for (const b of onTime) {
      const owed = outcome.refundsOwed.get(b.txid) ?? 0;
      if (owed > 0) refunds.push({ bidTxid: b.txid, amountZat: owed, reason: winnerSet.has(b.txid) ? "change" : "loser", memo: refundMemo(lotId, b.txid) });
    }
    for (const b of [...late, ...replays]) {
      refunds.push({ bidTxid: b.txid, amountZat: b.amountZat, reason: "late", memo: refundMemo(lotId, b.txid) });
    }

    const disclosure: Disclosure = {
      format: "imani-lot-disclosure/1",
      lotId,
      network,
      closeHeight,
      openHeight: i.from,
      refundByHeight: i.to,
      rules,
      ufvk: key,
      transactions: visible.map((x) => ({ txid: x.txid, height: x.height, txHex: x.txHex })),
    };
    const result: SellerResult = {
      format: "imani-lot-result/1",
      lotId,
      rules,
      bidCount: onTime.length,
      bids: onTime.map((b) => ({ txid: b.txid, amountZat: b.amountZat })),
      winners: outcome.winners,
      clearingPriceZat: outcome.clearingPriceZat,
      reserveMet: outcome.reserveMet,
      refunds,
    };

    const verdict = checkLot(disclosure, result, {
      scan: { blocks: i.blocks, missing: i.missing, source: i.source, graceBlocks: 0 },
    });

    // What the chain shows was paid back, per bid, for the summary on the page.
    const paid = new Map<string, number>();
    const refPrefix = `refund:${lotId}:`;
    for (const x of visible) for (const o of x.outputs) {
      if (o.transferType === "outgoing" && o.memo.startsWith(refPrefix)) {
        const id = o.memo.slice(refPrefix.length);
        paid.set(id, (paid.get(id) ?? 0) + o.amountZat);
      }
    }
    const amountOf = new Map(all.map((b) => [b.txid, b.amountZat]));
    const round: RefereeRound = {
      lotId,
      bidCount: onTime.length,
      lateBids: late.length + replays.length,
      winners: outcome.winners.map((t) => {
        const refund = outcome.refundsOwed.get(t) ?? 0;
        return { txid: t, amountZat: amountOf.get(t)!, paysZat: outcome.clearingPriceZat, refundZat: refund };
      }),
      clearingPriceZat: outcome.clearingPriceZat,
      pricing: i.pricing ?? "highest-losing",
      topUps: i.topUps === true,
      reserveMet: outcome.reserveMet,
      losers: onTime.filter((b) => !winnerSet.has(b.txid)).map((b) => ({ txid: b.txid, amountZat: b.amountZat })),
      refunds: refunds.map((r) => ({ bidTxid: r.bidTxid, owedZat: r.amountZat, paidZat: paid.get(r.bidTxid) ?? 0 })),
    };
    return { ok: true, verdict, round, closeAssumed };
  } catch (e) {
    if (e instanceof KeyRefusedError) return { ok: false, kind: "refused", message: e.message };
    if (e instanceof InputError || e instanceof ScanInputError) return { ok: false, kind: "input", message: e.message };
    return { ok: false, kind: "error", message: "Unexpected error while checking. Nothing was kept." };
  }
}
