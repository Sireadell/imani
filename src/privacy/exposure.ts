// Two more privacy checks next to linking.ts, read from the same lot disclosure.
//   Memos:  does any bid or refund memo carry more than the protocol needs (a transparent address,
//           an email, a link, a phone number or free text)? Whoever holds the lot key, and anyone the
//           key is shown to, can read it. The memo text itself is never printed, only what kind it is.
//   Timing: what a stranger who sees only block heights could pair up. A stranger sees which blocks hold
//           the lot's payments, not who sent them, how much or what the memo says. Refunds that follow
//           their bids by the same delay, or in the same order, let that stranger guess which refund
//           belongs to which bid.
// Both are notes, not failures: they never change the exit code of `imani linking`.
import type { Disclosure } from "../files.ts";
import { refundMemoPrefix } from "../files.ts";
import { readTransactionWithId } from "../read.ts";

export type MemoNoteKind = "transparent-address" | "contact-detail" | "extra-text";

export interface MemoNote {
  where: "bid" | "refund";
  txid: string;
  kind: MemoNoteKind;
}

export interface TimingFinding {
  kind: "same-delay" | "same-order" | "one-refund-block";
  detail: string;
}

export interface LotExposure {
  lotId: string;
  memosChecked: number;
  memoNotes: MemoNote[];
  bidBlocks: number;
  refundBlocks: number;
  timing: TimingFinding[];
}

const WORD = /^[A-Za-z0-9]{1,32}$/;
const SHIELDED = /^(u1|utest1|zs1|ztestsapling1)[a-z0-9]+$/;
const TRANSPARENT = /^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{20,}$/;
const EMAIL = /[^\s@:]+@[^\s@:]+\.[A-Za-z]{2,}/;
const LINK = /(https?:\/\/|www\.)/i;
const PHONE = /\+?\d[\d ()-]{8,}\d/;
const HEX64 = /^[0-9a-f]{64}$/;

/** What is wrong, if anything, with the text after `bid:<lot>:`. */
export function bidMemoNote(rest: string): MemoNoteKind | null {
  if (EMAIL.test(rest) || LINK.test(rest) || PHONE.test(rest)) return "contact-detail";
  const parts = rest.split(":");
  if (parts.length > 2 || !WORD.test(parts[0])) return "extra-text";
  if (parts.length === 2) {
    const a = parts[1].trim();
    if (TRANSPARENT.test(a)) return "transparent-address";
    if (!SHIELDED.test(a)) return "extra-text";
  }
  return null;
}

export function refundMemoNote(rest: string): MemoNoteKind | null {
  if (EMAIL.test(rest) || LINK.test(rest)) return "contact-detail";
  return HEX64.test(rest) ? null : "extra-text";
}

const clean = (m: string) => m.replace(/\0+$/, "").trim();

/** Timing notes from block heights alone: each pair is a bid's height and its refund's height. */
export function timingFindings(pairs: { bid: number; refund: number }[], refundHeights: number[]): TimingFinding[] {
  const timing: TimingFinding[] = [];
  const bidBlocks = new Set(pairs.map((p) => p.bid)).size;
  if (pairs.length >= 2 && bidBlocks >= 2) {
    const lags = pairs.map((p) => p.refund - p.bid);
    if (lags.every((l) => l === lags[0])) {
      timing.push({ kind: "same-delay", detail: `every refund arrives ${lags[0]} blocks after its bid, so a stranger can match them by counting blocks` });
    }
    const byBid = [...pairs].sort((a, b) => a.bid - b.bid || a.refund - b.refund);
    const distinctBids = bidBlocks === pairs.length;
    const distinctRefunds = new Set(pairs.map((p) => p.refund)).size === pairs.length;
    if (distinctBids && distinctRefunds && byBid.every((p, i) => i === 0 || p.refund > byBid[i - 1].refund)) {
      timing.push({ kind: "same-order", detail: "each bid and each refund is in a block of its own among this lot's payments and the refunds come in the same order as the bids, so a stranger can pair them by order" });
    }
  }
  if (refundHeights.length >= 2 && new Set(refundHeights).size === 1) {
    timing.push({ kind: "one-refund-block", detail: `all ${refundHeights.length} refunds are in one block, which hides their order. Good` });
  }
  return timing;
}

export function lotExposure(d: Disclosure): LotExposure {
  if (!d.ufvk) return { lotId: d.lotId, memosChecked: 0, memoNotes: [], bidBlocks: 0, refundBlocks: 0, timing: [] };
  const bidPrefix = `bid:${d.lotId}:`;
  const refPrefix = refundMemoPrefix(d.lotId);
  const memoNotes: MemoNote[] = [];
  let memosChecked = 0;
  const bidHeight = new Map<string, number>();
  const refunds: { bid: string; height: number }[] = [];
  for (const t of d.transactions) {
    const { txid, outputs } = readTransactionWithId(t.txHex, d.ufvk);
    for (const o of outputs) {
      const memo = clean(o.memo);
      if (o.transferType === "incoming" && memo.startsWith(bidPrefix)) {
        memosChecked++;
        bidHeight.set(txid, t.height);
        const kind = bidMemoNote(memo.slice(bidPrefix.length));
        if (kind) memoNotes.push({ where: "bid", txid, kind });
      } else if (o.transferType === "outgoing" && memo.startsWith(refPrefix)) {
        memosChecked++;
        const rest = memo.slice(refPrefix.length);
        refunds.push({ bid: rest, height: t.height });
        const kind = refundMemoNote(rest);
        if (kind) memoNotes.push({ where: "refund", txid, kind });
      }
    }
  }

  // Timing: only refunds that name a bid the key sees can be compared with it.
  const pairs = refunds.filter((r) => bidHeight.has(r.bid)).map((r) => ({ bid: bidHeight.get(r.bid)!, refund: r.height }));
  const bidBlocks = new Set(pairs.map((p) => p.bid)).size;
  const refundBlockSet = new Set(refunds.map((r) => r.height));
  const timing = timingFindings(pairs, refunds.map((r) => r.height));
  return { lotId: d.lotId, memosChecked, memoNotes, bidBlocks, refundBlocks: refundBlockSet.size, timing };
}

const short = (h: string) => `${h.slice(0, 8)}…`;
const WHY: Record<MemoNoteKind, string> = {
  "transparent-address": "a transparent address in a memo is public on the chain once spent from, and ties the bidder to it",
  "contact-detail": "an email, link or phone number names the bidder to whoever reads the memo",
  "extra-text": "text beyond the bid word and refund address is more than the protocol needs",
};

/** The notes number counts memo notes plus timing notes that are warnings. */
export function exposureNotes(ex: LotExposure[]): number {
  return ex.reduce((n, e) => n + e.memoNotes.length + e.timing.filter((t) => t.kind !== "one-refund-block").length, 0);
}

export function exposureText(ex: LotExposure[]): string[] {
  const lines: string[] = ["Extra checks on what the payments give away (notes only, they do not change the result below)", ""];
  for (const e of ex) {
    lines.push(`Lot ${e.lotId}`);
    if (e.memosChecked === 0) {
      lines.push("  Memos: nothing to check (no lot key in the file)", "");
      continue;
    }
    lines.push(`  Memos read with the lot key: ${e.memosChecked}. Notes: ${e.memoNotes.length}`);
    for (const k of Object.keys(WHY) as MemoNoteKind[]) {
      const hits = e.memoNotes.filter((n) => n.kind === k);
      if (hits.length) lines.push(`    ${hits.length} ${k}: ${WHY[k]} (${hits.map((h) => `${h.where} ${short(h.txid)}`).join(", ")})`);
    }
    lines.push(`  What a stranger sees by block: bids in ${e.bidBlocks} block(s), refunds in ${e.refundBlocks} block(s)`);
    if (e.timing.length === 0) lines.push("    No timing pattern that lets a stranger pair a refund with a bid");
    for (const t of e.timing) lines.push(`    ${t.kind === "one-refund-block" ? "ok" : "note"}: ${t.detail}`);
    lines.push("");
  }
  lines.push("How to avoid them: keep memos to the bid word and one fresh shielded address, and send the refunds together or in a mixed order and with different delays.", "");
  return lines;
}
