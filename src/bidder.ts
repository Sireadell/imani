// Bidder check: a bidder confirms "my bid landed and my refund is right" with their own
// viewing key and public chain data only. No seller file, no lot key. See docs/BIDDER_CHECK.md.

import { readTransactionWithId, parseAddress, type ReadOutput } from "./read.ts";
import { bidMemoAddress, bidMemoPrefix, refundMemo } from "./files.ts";
import { InputError } from "./check.ts";
import { scanRange } from "./scan/scan.ts";
import type { BlockSource, ChainBlock } from "./scan/chain.ts";

/** What the seller publishes before the auction, so every bidder already has it. */
export interface LotPublicFacts {
  format: "imani-lot-public/1";
  lotId: string;
  network: "main" | "test";
  openHeight: number;
  closeHeight: number;
  refundByHeight: number;
  /** Optional. The lot's payment address, so a bid can be shown to have gone to it. */
  lotAddress?: string;
  /** Optional. Lowest price the seller accepts, in zatoshis. */
  reserveZat?: number;
}

export function validateFacts(f: any): asserts f is LotPublicFacts {
  const bad = (m: string): never => {
    throw new InputError(`Input error: the lot facts file ${m}`);
  };
  if (!f || f.format !== "imani-lot-public/1") bad('must have "format": "imani-lot-public/1".');
  if (typeof f.lotId !== "string" || f.lotId === "") bad("needs a lotId.");
  if (f.network !== "main" && f.network !== "test") bad('needs "network": "main" or "test".');
  for (const k of ["openHeight", "closeHeight", "refundByHeight"]) {
    if (!Number.isSafeInteger(f[k]) || f[k] < 1) bad(`needs a whole number ${k}.`);
  }
  if (f.lotAddress !== undefined) {
    try {
      parseAddress(f.lotAddress);
    } catch {
      bad("has a lotAddress that is not a Zcash shielded address.");
    }
  }
  if (f.reserveZat !== undefined && (!Number.isSafeInteger(f.reserveZat) || f.reserveZat < 0)) bad("has a reserveZat that is not a whole number.");
}

/** A bid the bidder names: its transaction id, and optionally the amount their wallet says they paid. */
export interface BidClaim {
  txid: string;
  amountZat?: number;
}

/** GIVEN: taken from the bidder's word, not proven. It does not lower the result, and is always shown. */
export type Mark = "PROVEN" | "GIVEN" | "NOT PROVEN" | "FAIL";
export interface Line {
  id: string;
  mark: Mark;
  text: string;
}
export interface BidReport {
  txid: string;
  lines: Line[];
}
export interface BidderReport {
  lotId: string;
  result: "PASS" | "FAIL" | "NOT PROVEN";
  blocksRead: number;
  from: number;
  to: number;
  source: BlockSource;
  bids: BidReport[];
  general: string[];
}

/** The seller's published result. Optional: only used to cross-check, never required. */
export interface PublishedResult {
  bids: { txid: string; amountZat: number }[];
  winners?: string[];
  clearingPriceZat?: number;
  refunds: { bidTxid: string; amountZat: number }[];
}

interface Seen {
  txid: string;
  height: number;
  outputs: ReadOutput[];
}

export interface BidderInput {
  facts: LotPublicFacts;
  ufvk: string;
  blocks: ChainBlock[];
  missing: number[];
  source: BlockSource;
  graceBlocks: number;
  /** Bids to check. When empty, every bid the key can read as paid to this lot is checked. */
  bids: BidClaim[];
  published?: PublishedResult;
}

const zat = (n: number) => `${n.toLocaleString("en-US")} zat`;
const short = (t: string) => t.slice(0, 10);

/** What a bidder alone can and cannot prove. Printed with every report. */
export const LIMITS = [
  "You can prove alone: your bid payment is on the chain at a block height (before or after the close), and the refund payments sent to your wallet for it, with their heights and amounts.",
  "You cannot prove alone: what the other bids were, so the clearing price cannot be confirmed from your key. If you won, the check shows the price you paid (your bid minus your refund) and that it is within your bid and not below the reserve, never that it is the right price.",
  "You cannot prove alone: whether you won. A refund of your whole bid fits losing. A smaller refund fits winning. No refund fits winning at your full bid or a refund the seller never paid, and your key cannot tell those apart (NOT PROVEN).",
  "Your key may not show your own outgoing payment if your wallet does not keep the sender view of what it sends. Then the check finds your bid by the transaction id you give and takes the amount you give, and says so.",
  "The seller's published result is optional. With it, the check also compares your bid and refund with what the seller claims, and a bid left out or a refund that does not match fails.",
];

/**
 * The blocks a bidder check reads: the open height to the refund deadline plus the grace window,
 * so a refund that came after the deadline is found and called late, not missed.
 */
export function bidderRange(facts: LotPublicFacts, graceBlocks: number): { from: number; to: number } {
  const r = scanRange(facts, graceBlocks);
  return { from: r.from, to: Math.max(r.to, r.refundByHeight + graceBlocks) };
}

export function bidderCheck(inp: BidderInput): BidderReport {
  const { facts } = inp;
  const range = bidderRange(facts, inp.graceBlocks);
  const inRange = inp.blocks.filter((b) => b.height >= range.from && b.height <= range.to).sort((a, b) => a.height - b.height);
  const seen = new Map<string, Seen>();
  const problems: string[] = [];
  for (const b of inRange) {
    for (const t of b.txs) {
      let res;
      try {
        res = readTransactionWithId(t.txHex, inp.ufvk);
      } catch {
        problems.push(`a transaction in block ${b.height} could not be read`);
        continue;
      }
      if (res.txid !== t.txid.toLowerCase()) {
        problems.push(`block ${b.height} lists transaction ${short(t.txid)} but its bytes are another transaction`);
        continue;
      }
      if (!seen.has(res.txid)) seen.set(res.txid, { txid: res.txid, height: b.height, outputs: res.outputs });
    }
  }
  // The blocks up to the refund deadline must all be there. The extra blocks after it, which only
  // serve to spot a late refund, are best effort: when absent the report says so.
  const core = scanRange(facts, inp.graceBlocks).to;
  const missing = [...new Set(inp.missing)].filter((h) => h >= range.from && h <= core);
  const have = new Set(inRange.map((b) => b.height));
  let coreMissing = 0;
  for (let h = range.from; h <= core; h++) if (!have.has(h)) coreMissing++;
  const complete = missing.length === 0 && coreMissing === 0 && problems.length === 0;
  const lateMissing = range.to - core - [...have].filter((h) => h > core).length;

  let lotHex: { orchard: string | null; sapling: string | null } | null = null;
  if (facts.lotAddress) {
    const p = parseAddress(facts.lotAddress);
    lotHex = { orchard: p.orchard, sapling: p.sapling };
  }
  const toLot = (o: ReadOutput) => !lotHex || o.recipientHex === lotHex.orchard || o.recipientHex === lotHex.sapling;
  const prefix = bidMemoPrefix(facts.lotId);

  // Bids the key reads as its own outgoing payments to this lot.
  const readable = new Map<string, number>();
  for (const x of seen.values()) {
    const outs = x.outputs.filter((o) => o.transferType === "outgoing" && o.memo.startsWith(prefix) && toLot(o));
    if (outs.length) readable.set(x.txid, outs.reduce((s, o) => s + o.amountZat, 0));
  }
  const claims: BidClaim[] = inp.bids.length
    ? inp.bids.map((b) => ({ ...b, txid: b.txid.toLowerCase() }))
    : [...readable].map(([txid, amountZat]) => ({ txid, amountZat }));

  const general: string[] = [];
  if (!complete) {
    general.push(
      `The read of the lot's range is not complete (${missing.length || coreMissing ? `${Math.max(missing.length, coreMissing)} blocks missing` : "all blocks present"}${problems.length ? `; ${problems.slice(0, 3).join("; ")}` : ""}), so a payment could be in a block that was not read.`,
    );
  }
  if (complete && lateMissing > 0) general.push(`Note: ${lateMissing} of the ${range.to - core} blocks after the refund deadline were not read, so a refund paid after the deadline might not be seen.`);
  if (claims.length === 0) general.push("Your key shows no bid paid to this lot in the range. Give the transaction id of your bid with --bid <txid>.");

  const bids: BidReport[] = claims.map((c) => {
    const lines: Line[] = [];
    const add = (id: string, mark: Mark, text: string) => lines.push({ id, mark, text });
    const tx = seen.get(c.txid);
    const readableAmount = readable.get(c.txid);
    if (c.amountZat !== undefined && readableAmount !== undefined && c.amountZat !== readableAmount) {
      add("amount", "FAIL", `You said you paid ${zat(c.amountZat)}, but your key reads ${zat(readableAmount)} in that payment.`);
    }
    const amount = readableAmount ?? c.amountZat;
    if (!tx) {
      add("landed", "FAIL", `Your bid payment ${short(c.txid)} is not in any block from ${range.from} to ${range.to}. It never landed in this lot's window, or the id is wrong.`);
      return { txid: c.txid, lines };
    }
    const h = tx.height;
    const onTime = h >= facts.openHeight && h <= facts.closeHeight;
    const where = onTime
      ? `inside the bidding window (${facts.openHeight} to ${facts.closeHeight})`
      : h > facts.closeHeight
        ? `AFTER the close at ${facts.closeHeight}: it should not count and must be refunded in full`
        : `BEFORE the open at ${facts.openHeight}: it should not count and must be refunded in full`;
    add("landed", "PROVEN", `Your bid payment ${short(c.txid)} is in block ${h}, ${where}. The height comes from the chain, not from the seller.`);
    if (readableAmount !== undefined) {
      add("paid", "PROVEN", `Your key reads this payment as ${zat(readableAmount)} ${facts.lotAddress ? "sent to the lot address in the published facts" : "with a bid memo of this lot"}.`);
      const own = tx.outputs.find((o) => o.transferType === "outgoing" && o.memo.startsWith(prefix));
      if (own && bidMemoAddress(facts.lotId, own.memo)) {
        add("memo", "PROVEN", "Your bid memo carries a refund address you wrote, so the seller could not choose where the refund goes.");
      }
    } else {
      add(
        "paid",
        c.amountZat !== undefined ? "GIVEN" : "NOT PROVEN",
        `Your key cannot read this payment's amount or destination. ${c.amountZat !== undefined ? `The amount ${zat(c.amountZat)} is your word, not proven.` : "No amount was given, so refunds cannot be compared with your bid."}`,
      );
    }

    // Refunds: incoming payments to this key carrying the refund memo of this bid.
    const wantMemo = refundMemo(facts.lotId, c.txid);
    const refunds: { height: number; amountZat: number }[] = [];
    for (const x of seen.values()) {
      if (x.height < h) continue;
      for (const o of x.outputs) if (o.transferType === "incoming" && o.memo === wantMemo) refunds.push({ height: x.height, amountZat: o.amountZat });
    }
    const early = refunds.filter((r) => r.height <= facts.refundByHeight);
    const late = refunds.filter((r) => r.height > facts.refundByHeight);
    const got = early.reduce((s, r) => s + r.amountZat, 0);
    if (late.length) {
      add("late-refund", "FAIL", `A refund of ${zat(late.reduce((s, r) => s + r.amountZat, 0))} for your bid arrived at block ${late[0].height}, after the refund deadline at ${facts.refundByHeight}.`);
    }
    const reserve = facts.reserveZat;
    if (amount === undefined) {
      add(
        "refund",
        "NOT PROVEN",
        early.length
          ? `Refund received by block ${facts.refundByHeight}: ${zat(got)} (${early.map((r) => `block ${r.height}`).join(", ")}). Without your bid amount it cannot be compared.`
          : `No refund for your bid reached your key by block ${facts.refundByHeight}. Without your bid amount this cannot tell a missing refund from a win at your full bid.`,
      );
    } else if (!onTime) {
      if (got === amount) add("refund", "PROVEN", `Your outside-the-window bid was refunded in full: ${zat(got)} by block ${facts.refundByHeight}.`);
      else if (!late.length || got > 0) add("refund", "FAIL", `Your bid was outside the window, so the whole ${zat(amount)} must come back, and your key received ${zat(got)} by block ${facts.refundByHeight}.`);
    } else if (got > amount) {
      add("refund", "FAIL", `The refund ${zat(got)} is more than your bid ${zat(amount)}.`);
    } else if (got === amount) {
      add("refund", "PROVEN", `You were refunded your whole bid: ${zat(got)} in ${early.length} payment(s) by block ${facts.refundByHeight}. That fits a bid that did not win.`);
    } else if (got > 0) {
      const price = amount - got;
      if (reserve !== undefined && price < reserve) {
        add("refund", "FAIL", `You paid ${zat(price)} (your bid ${zat(amount)} minus the refund ${zat(got)}), which is below the reserve ${zat(reserve)}. A winner never pays less than the reserve.`);
      } else {
        add(
          "refund",
          "PROVEN",
          `Your refund is ${zat(got)} of your ${zat(amount)} bid, so you paid ${zat(price)}${reserve !== undefined ? `, within your bid and not below the reserve ${zat(reserve)}` : ", within your bid"}. That fits a win. Whether ${zat(price)} is the right clearing price your key cannot show: that needs every bid.`,
        );
      }
    } else if (!late.length) {
      add("refund", "NOT PROVEN", `No refund for your bid reached your key by block ${facts.refundByHeight}. If you won at your full bid that is right. If you did not win, the refund of ${zat(amount)} is missing. Your key alone cannot tell which.`);
    }

    // Optional cross-check with the seller's published result.
    const pub = inp.published;
    if (pub) {
      const counted = pub.bids.find((b) => b.txid.toLowerCase() === c.txid);
      const entries = pub.refunds.filter((f) => f.bidTxid.toLowerCase() === c.txid);
      const claimed = entries.reduce((s, f) => s + f.amountZat, 0);
      if (onTime && !counted) add("seller-counted", "FAIL", "Your bid landed inside the window but the seller's published result does not count it.");
      else if (!onTime && counted) add("seller-counted", "FAIL", "Your bid landed outside the window but the seller's published result counts it.");
      else if (counted && amount !== undefined && counted.amountZat !== amount) add("seller-counted", "FAIL", `The seller counts your bid as ${zat(counted.amountZat)}, but you paid ${zat(amount)}.`);
      else add("seller-counted", "PROVEN", onTime ? `The seller's result counts your bid at ${zat(counted!.amountZat)}.` : "The seller's result does not count your outside-the-window bid.");
      if (claimed === got) add("seller-refund", "PROVEN", entries.length ? `The seller says your refund is ${zat(claimed)}, and that is what reached your key.` : "The seller lists no refund for your bid, and your key received none.");
      else add("seller-refund", "FAIL", `The seller says your refund is ${zat(claimed)} but your key received ${zat(got)}.`);
      if (pub.winners && counted && pub.clearingPriceZat !== undefined && pub.winners.map((w) => w.toLowerCase()).includes(c.txid)) {
        const should = counted.amountZat - pub.clearingPriceZat;
        if (got !== should) add("seller-price", "FAIL", `The seller says you won at ${zat(pub.clearingPriceZat)}, so your refund should be ${zat(should)}, and it was ${zat(got)}.`);
      }
    }
    return { txid: c.txid, lines };
  });

  const all = bids.flatMap((b) => b.lines);
  const result: BidderReport["result"] =
    all.some((l) => l.mark === "FAIL") || !complete ? "FAIL" : all.some((l) => l.mark === "NOT PROVEN") || bids.length === 0 ? "NOT PROVEN" : "PASS";
  return { lotId: facts.lotId, result, blocksRead: inRange.length, from: range.from, to: range.to, source: inp.source, bids, general };
}

export function bidderText(r: BidderReport): string {
  const out: string[] = [];
  out.push(`Bidder check for lot ${r.lotId}. Uses only your own viewing key and public chain data.`);
  out.push(`Read ${r.blocksRead} blocks, ${r.from} to ${r.to}, from ${r.source.label}.`);
  for (const g of r.general) out.push(`! ${g}`);
  for (const b of r.bids) {
    out.push("", `Bid ${b.txid}`);
    for (const l of b.lines) out.push(`  [${l.mark}] ${l.text}`);
  }
  out.push("", `RESULT: ${r.result}${r.result === "NOT PROVEN" ? " (nothing wrong was found, but your key alone cannot settle everything)" : ""}`);
  out.push("", "What a bidder alone can and cannot prove:");
  for (const l of LIMITS) out.push(`  - ${l}`);
  out.push("", `Servers contacted: ${r.source.serversContacted.length ? r.source.serversContacted.join(", ") : "none"}`);
  return out.join("\n");
}
