// Who learns what in one auction, worked out from the round's own files rather than typed by hand.
import type { Disclosure } from "../files.ts";
import { readTransactionWithId } from "../read.ts";
import { scanRange, DEFAULT_GRACE_BLOCKS } from "../scan/scan.ts";
import { linkingFromLots, lotRefunds } from "./linking.ts";

export interface WhoLearnsRow {
  party: string;
  learns: string;
  cannotLearn: string;
}

export interface WhoLearnsReport {
  lotId: string;
  blocks: number;
  transactionsInRange: number;
  lotTransactions: number;
  bids: number;
  refunds: number;
  linksOutside: number;
  rows: WhoLearnsRow[];
}

export function whoLearns(d: Disclosure, chain: { blocks: { height: number; txs: { txHex: string }[] }[] }): WhoLearnsReport {
  const range = scanRange(d, DEFAULT_GRACE_BLOCKS);
  const blocks = chain.blocks.filter((b) => b.height >= range.from && b.height <= range.to);
  let txs = 0;
  let seen = 0;
  for (const b of blocks)
    for (const t of b.txs) {
      txs++;
      if (readTransactionWithId(t.txHex, d.ufvk as string).outputs.length) seen++;
    }
  const lot = lotRefunds(d);
  const link = linkingFromLots([lot]);
  const bids = lot.bids.length;
  const refunds = lot.refunds.length;
  const rows: WhoLearnsRow[] = [
    {
      party: "Anyone, without the lot key",
      learns: `That ${txs} shielded transactions in ${blocks.length} blocks happened, and their fees`,
      cannotLearn: `Any amount, memo or address, or even which ${seen} belong to this auction`,
    },
    {
      party: "Anyone, once the seller publishes the lot key",
      learns: `The ${bids} bid amounts, their memos with each bidder's refund address, the ${refunds} refunds and which bid each one pays back`,
      cannotLearn: `Who the bidders are, what else is in their wallets, or any payment outside this auction. Refund links that reach outside the round: ${link.linksOutside}`,
    },
    {
      party: "The seller",
      learns: "Each bid as it arrives, because the lot key is the seller's",
      cannotLearn: "Anything else in the bidders' wallets. The seller can see bids early, which the check cannot rule out",
    },
    {
      party: "Each bidder",
      learns: "Their own bid and refund, and after the close everything the lot key shows",
      cannotLearn: "Other bidders' wallets or identities",
    },
    {
      party: "This page and its host",
      learns: "That the page was downloaded",
      cannotLearn: "Anything you check here: the page makes no network calls after it loads",
    },
  ];
  return { lotId: d.lotId, blocks: blocks.length, transactionsInRange: txs, lotTransactions: seen, bids, refunds, linksOutside: link.linksOutside, rows };
}

export function whoLearnsMarkdown(rep: WhoLearnsReport): string {
  const lines = ["| Who | Learns | Cannot learn |", "|---|---|---|"];
  for (const r of rep.rows) lines.push(`| ${r.party} | ${r.learns} | ${r.cannotLearn} |`);
  return lines.join("\n") + "\n";
}
