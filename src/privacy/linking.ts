// How far a refund can be followed by anyone who has the lot key.
//
// Inside a round the link is on purpose: each refund names its bid, which is what lets anyone
// check the refunds. What must not happen is a link that reaches outside the round: one
// receiver paid for two bids (one bidder seen twice), or the same receiver showing up in another
// round (one bidder followed from lot to lot). Fresh addresses prevent both, because two
// addresses made from one wallet cannot be tied together by anyone without that wallet's key.
import type { Disclosure } from "../files.ts";
import { refundMemoPrefix } from "../files.ts";
import { readTransactionWithId } from "../read.ts";

export interface LotRefunds {
  lotId: string;
  /** Transaction ids of the bids the lot key sees. */
  bids: string[];
  /** Refunds the lot key sees, with the receiver each was paid to. */
  refunds: { bidTxid: string; receiver: string }[];
}

export interface LotLinking {
  lotId: string;
  bids: number;
  refunds: number;
  /** Refunds whose memo names a bid the lot key sees. */
  refundsNamingABid: number;
  receivers: number;
  reusedInRound: { receiver: string; bids: string[] }[];
}

export interface LinkingReport {
  lots: LotLinking[];
  /** Receivers that appear in more than one round, with the rounds. */
  acrossRounds: { receiver: string; lots: string[] }[];
  /** Links that reach outside a single bid: reuse inside a round plus reuse across rounds. */
  linksOutside: number;
}

export class LinkingInputError extends Error {}

/** Read the bids and refunds of a lot with its key. */
export function lotRefunds(d: Disclosure): LotRefunds {
  if (!d.ufvk) throw new LinkingInputError(`The disclosure for ${d.lotId} has no lot key, so its refunds cannot be read.`);
  const prefix = refundMemoPrefix(d.lotId);
  const bids: string[] = [];
  const refunds: LotRefunds["refunds"] = [];
  for (const t of d.transactions) {
    const { txid, outputs } = readTransactionWithId(t.txHex, d.ufvk);
    for (const o of outputs) {
      if (o.transferType === "incoming" && o.memo.startsWith(`bid:${d.lotId}:`)) bids.push(txid);
      else if (o.transferType === "outgoing" && o.memo.startsWith(prefix)) refunds.push({ bidTxid: o.memo.slice(prefix.length), receiver: o.recipientHex });
    }
  }
  return { lotId: d.lotId, bids, refunds };
}

export function linkingFromLots(lots: LotRefunds[]): LinkingReport {
  const seen = new Map<string, Set<number>>();
  const out: LotLinking[] = lots.map((l, round) => {
    const byReceiver = new Map<string, Set<string>>();
    for (const f of l.refunds) {
      if (!byReceiver.has(f.receiver)) byReceiver.set(f.receiver, new Set());
      byReceiver.get(f.receiver)!.add(f.bidTxid);
      if (!seen.has(f.receiver)) seen.set(f.receiver, new Set());
      seen.get(f.receiver)!.add(round);
    }
    const bidSet = new Set(l.bids);
    return {
      lotId: l.lotId,
      bids: l.bids.length,
      refunds: l.refunds.length,
      refundsNamingABid: l.refunds.filter((f) => bidSet.has(f.bidTxid)).length,
      receivers: byReceiver.size,
      reusedInRound: [...byReceiver].filter(([, b]) => b.size > 1).map(([receiver, b]) => ({ receiver, bids: [...b].sort() })),
    };
  });
  const acrossRounds = [...seen].filter(([, s]) => s.size > 1).map(([receiver, s]) => ({ receiver, lots: [...s].map((i) => `${lots[i].lotId} (round ${i + 1})`) }));
  const linksOutside = out.reduce((n, l) => n + l.reusedInRound.length, 0) + acrossRounds.length;
  return { lots: out, acrossRounds, linksOutside };
}

export function linkingText(rep: LinkingReport, extra: string[] = []): string {
  const short = (h: string) => `${h.slice(0, 8)}…`;
  const lines = ["How far a refund can be followed by anyone who has the lot key", "Servers contacted: none", ""];
  for (const l of rep.lots) {
    lines.push(
      `Lot ${l.lotId}${rep.lots.filter((x) => x.lotId === l.lotId).length > 1 ? ` (round ${rep.lots.indexOf(l) + 1})` : ""}`,
      `  Bids the lot key sees: ${l.bids}`,
      `  Refunds that name their bid: ${l.refundsNamingABid} of ${l.refunds}. This link is on purpose: it is what lets anyone check the refunds.`,
      `  Different refund receivers: ${l.receivers}`,
      `  Receivers paid more than once in this round: ${l.reusedInRound.length}${l.reusedInRound.map((r) => `\n    receiver ${short(r.receiver)} was paid for bids ${r.bids.map(short).join(", ")}, so those bids look like one bidder`).join("")}`,
      "",
    );
  }
  lines.push(`Receivers seen in more than one round: ${rep.acrossRounds.length}${rep.acrossRounds.map((r) => `\n  receiver ${short(r.receiver)} was paid in ${r.lots.join(" and in ")}, so that bidder can be followed from one to the other`).join("")}`);
  lines.push(
    "",
    "What someone without the lot key sees: that shielded payments happened, in which blocks, and their fees. No amounts, no memos, no addresses.",
    "How bidders keep it this way: write a fresh address in each bid memo. Two addresses made from one wallet cannot be tied together without that wallet's own key.",
    "",
    ...extra,
    rep.linksOutside === 0
      ? "RESULT: NO LINKS OUTSIDE THE ROUND"
      : `RESULT: ${rep.linksOutside} ${rep.linksOutside === 1 ? "LINK" : "LINKS"} ${rep.acrossRounds.length && !rep.lots.some((l) => l.reusedInRound.length) ? "BETWEEN ROUNDS" : "OUTSIDE A SINGLE BID"}`,
  );
  return lines.join("\n") + "\n";
}
