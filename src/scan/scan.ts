// Scan level: read every block in the lot's range with the lot key and compare what the
// chain holds with what the seller disclosed. This closes two gaps of the key level, which
// only reads the transactions the seller chose to list and takes their block heights on
// the seller's word. See SPEC.md, "Scan level".

import { readTransactionWithId, type ReadOutput } from "../read.ts";
import { bidMemoAddress, bidMemoPrefix, openMemoPrefix, refundMemoPrefix, sealMemoPrefix, type Disclosure } from "../files.ts";
import type { Check } from "../check.ts";
import { ScanInputError, type BlockSource, type ChainBlock } from "./chain.ts";

/** Default grace window: the scan always reads at least this many blocks past the close. */
export const DEFAULT_GRACE_BLOCKS = 10;

/** A bidder's own viewing key, given by that bidder to prove their refund reached them. */
export interface BidderKey {
  bidTxid: string;
  ufvk: string;
}

export interface ScanInput {
  /** Blocks the source returned for the range, in any order. */
  blocks: ChainBlock[];
  /** Heights in the range the source did not have. */
  missing: number[];
  source: BlockSource;
  graceBlocks: number;
  /** Optional: bidders' own keys, already checked to be read-only viewing keys. */
  bidderKeys?: BidderKey[];
}

export interface ScanRange {
  from: number;
  to: number;
  openHeight: number;
  closeHeight: number;
  refundByHeight: number;
  graceBlocks: number;
}

const isHeight = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/**
 * The blocks a scan must read: from the open height to the refund deadline, and always at
 * least `graceBlocks` past the close, so a bid that just missed the close is found.
 */
export function scanRange(d: Pick<Disclosure, "openHeight" | "closeHeight" | "refundByHeight">, graceBlocks = DEFAULT_GRACE_BLOCKS): ScanRange {
  const bad = (what: string): never => {
    throw new ScanInputError(`Input error: ${what}`);
  };
  if (!isHeight(d.openHeight)) bad("the scan needs openHeight (the first block at which a bid counts) in the disclosure file.");
  if (!isHeight(d.refundByHeight)) bad("the scan needs refundByHeight (the last block by which every refund is paid) in the disclosure file.");
  if (!isHeight(d.closeHeight)) bad("the scan needs a valid closeHeight.");
  if (!Number.isSafeInteger(graceBlocks) || graceBlocks < 0 || graceBlocks > 10_000) bad("the grace window must be a whole number of blocks from 0 to 10000.");
  const open = d.openHeight as number;
  const close = d.closeHeight;
  const refundBy = d.refundByHeight as number;
  if (open > close) bad(`openHeight ${open} is after closeHeight ${close}.`);
  if (refundBy < close) bad(`refundByHeight ${refundBy} is before closeHeight ${close}.`);
  const to = Math.max(refundBy, close + graceBlocks);
  if (to - open + 1 > 100_000) bad(`the range from ${open} to ${to} is more than 100,000 blocks.`);
  return { from: open, to, openHeight: open, closeHeight: close, refundByHeight: refundBy, graceBlocks };
}

/** "4200001 to 4200003, 4200009" from a sorted list of heights. */
export function heightRuns(hs: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < hs.length; ) {
    let j = i;
    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
    runs.push(i === j ? `${hs[i]}` : `${hs[i]} to ${hs[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

interface SeenTx {
  txid: string;
  height: number;
  outputs: ReadOutput[];
}

type Add = (c: Omit<Check, "fromChain" | "fromSeller" | "fromDisclosure"> & Partial<Check>) => void;

/**
 * Run the scan-level checks and add them with `add`. Returns a short note for the report.
 * Never contacts a server: the blocks are already in `scan`.
 */
export function scanChecks(
  d: Disclosure,
  key: string,
  scan: ScanInput,
  add: Add,
  zat: (n: number) => string,
  memo: (m: string) => string,
  short: (t: string) => string,
): string[] {
  const range = scanRange(d, scan.graceBlocks);
  const hideKey = (s: string) => s.split(key).join("[key]");

  // ---- Read every transaction of every block in the range with the lot key ----
  const inRange = scan.blocks.filter((b) => b.height >= range.from && b.height <= range.to).sort((a, b) => a.height - b.height);
  const readProblems: string[] = [];
  const all = new Map<string, SeenTx>(); // every transaction in the range, by txid
  let txCount = 0;
  for (const b of inRange) {
    for (const t of b.txs) {
      txCount++;
      let res;
      try {
        res = readTransactionWithId(t.txHex, key);
      } catch (e) {
        readProblems.push(`transaction ${short(t.txid)} in block ${b.height} could not be read (${hideKey(String((e as Error)?.message ?? e)).slice(0, 120)})`);
        continue;
      }
      if (res.txid !== t.txid.toLowerCase()) {
        readProblems.push(`block ${b.height} lists transaction ${short(t.txid)} but its bytes are transaction ${short(res.txid)}`);
        continue;
      }
      if (all.has(res.txid)) {
        readProblems.push(`transaction ${short(res.txid)} appears in blocks ${all.get(res.txid)!.height} and ${b.height}`);
        continue;
      }
      all.set(res.txid, { txid: res.txid, height: b.height, outputs: res.outputs });
    }
  }
  const missing = [...new Set(scan.missing)].filter((h) => h >= range.from && h <= range.to).sort((a, b) => a - b);
  const blocksWanted = range.to - range.from + 1;
  const complete = missing.length === 0 && inRange.length === blocksWanted && readProblems.length === 0;
  const visible = [...all.values()].filter((x) => x.outputs.some((o) => o.transferType !== "internal"));
  add({
    id: "scan-blocks-read",
    level: 3,
    title: "Every block in the lot's range was read",
    status: complete ? "PASS" : "FAIL",
    reason: complete
      ? `Read all ${blocksWanted} blocks from ${range.from} to ${range.to} (${txCount} transactions) from ${scan.source.label}. Every transaction id was recomputed from its bytes. The lot key sees ${visible.length} of them.`
      : [
          `The scan is not complete, so a hidden bid could be in a block that was not read.`,
          missing.length ? `Blocks missing: ${heightRuns(missing)}.` : "",
          readProblems.length ? `${readProblems.slice(0, 5).join("; ")}${readProblems.length > 5 ? `; and ${readProblems.length - 5} more` : ""}.` : "",
        ].filter(Boolean).join(" "),
    fromChain: [`${inRange.length} of ${blocksWanted} blocks read`, `${txCount} transactions`, `${visible.length} seen by the lot key`],
    fromDisclosure: [
      `open height ${range.openHeight}`,
      `close height ${range.closeHeight}`,
      `refunds by height ${range.refundByHeight}`,
      `grace window ${range.graceBlocks} blocks after the close`,
    ],
  });

  // ---- Sort what the key sees ----
  const bidPrefix = bidMemoPrefix(d.lotId);
  const refPrefix = refundMemoPrefix(d.lotId);
  const listed = new Map<string, number>();
  for (const t of d.transactions) if (typeof t.txid === "string") listed.set(t.txid.toLowerCase(), t.height);

  const describe = (x: SeenTx) =>
    x.outputs
      .filter((o) => o.transferType !== "internal")
      .map((o) => `${o.transferType} ${zat(o.amountZat)}, memo ${memo(o.memo)}`)
      .join(" and ");
  // In a sealed lot the bid facts are the seals and the openings.
  const bidPrefixes = d.rules.kind === "sealed" ? [sealMemoPrefix(d.lotId), openMemoPrefix(d.lotId)] : [bidPrefix];
  const isBidOut = (o: SeenTx["outputs"][number]) => o.transferType === "incoming" && bidPrefixes.some((p) => o.memo.startsWith(p));
  const isBid = (x: SeenTx) => x.outputs.some(isBidOut);
  const bidAmount = (x: SeenTx) => x.outputs.filter(isBidOut).reduce((s, o) => s + o.amountZat, 0);
  const bidMemo = (x: SeenTx) => x.outputs.find(isBidOut)!.memo;
  const bidKind = (x: SeenTx) =>
    d.rules.kind !== "sealed" ? "bid" : bidMemo(x).startsWith(openMemoPrefix(d.lotId)) ? "opening" : "seal";
  const when = (h: number) => (h > range.closeHeight ? ", after the close" : h < range.openHeight ? ", before the open" : "");

  // Hidden bids: bid payments on the chain the seller did not list.
  const chainBids = visible.filter(isBid);
  const bidMemoHasAddress = chainBids.some((x) => bidMemoAddress(d.lotId, bidMemo(x)) !== null);
  const hidden = chainBids.filter((x) => !listed.has(x.txid));
  add({
    id: "scan-hidden-bids",
    level: 3,
    title: "No bid on the chain was left out by the seller",
    status: hidden.length ? "FAIL" : "PASS",
    reason: hidden.length
      ? hidden
          .map((x) => `hidden ${bidKind(x)}: ${short(x.txid)} at block ${x.height}${when(x.height)}, ${zat(bidAmount(x))}, memo ${memo(bidMemo(x))}, is on the chain but not in the seller's disclosure.`)
          .join(" ")
      : `Every one of the ${chainBids.length} bid payments the lot key sees in blocks ${range.from} to ${range.to} is in the seller's disclosure.`,
    fromChain: chainBids.map((x) => `bid ${short(x.txid)} at block ${x.height}: ${zat(bidAmount(x))}${listed.has(x.txid) ? "" : " (not listed)"}`),
    fromDisclosure: [`${listed.size} transactions listed`],
  });

  // Other payments the key sees (refunds, payments that are not bids) that were not listed.
  const otherUnlisted = visible.filter((x) => !isBid(x) && !listed.has(x.txid));
  add({
    id: "scan-unlisted-payments",
    level: 3,
    title: "No other payment of the lot was left out",
    status: otherUnlisted.length ? "FAIL" : "PASS",
    reason: otherUnlisted.length
      ? otherUnlisted
          .map((x) => {
            const refund = x.outputs.some((o) => o.transferType === "outgoing" && o.memo.startsWith(refPrefix));
            return `unlisted ${refund ? "refund" : "payment"}: ${short(x.txid)} at block ${x.height} (${describe(x)}) is on the chain but not in the seller's disclosure.`;
          })
          .join(" ")
      : `Every refund and other payment the lot key sees in the range is in the seller's disclosure.`,
    fromChain: visible.filter((x) => !isBid(x)).map((x) => `${short(x.txid)} at block ${x.height}: ${describe(x)}`),
  });

  // Listed transactions must be in the range.
  const notInRange = [...listed].filter(([txid]) => !all.has(txid));
  add({
    id: "scan-listed-in-range",
    level: 3,
    title: "Every listed payment is in the lot's range",
    status: notInRange.length ? "FAIL" : "PASS",
    reason: notInRange.length
      ? notInRange
          .map(([txid, h]) => `listed payment not in the range: ${short(txid)} (the seller says block ${h}) is in none of the blocks ${range.from} to ${range.to}.`)
          .join(" ")
      : `All ${listed.size} listed transactions were found in blocks ${range.from} to ${range.to}.`,
    fromChain: [`${all.size} transactions in the range`],
    fromDisclosure: [`${listed.size} transactions listed`],
  });

  // Heights: the block the scan found each listed transaction in, against the seller's claim.
  const wrongHeights: string[] = [];
  let compared = 0;
  for (const [txid, claimed] of listed) {
    const seen = all.get(txid);
    if (!seen) continue; // judged by scan-listed-in-range
    compared++;
    if (seen.height !== claimed) {
      const crosses = (claimed <= range.closeHeight) !== (seen.height <= range.closeHeight);
      wrongHeights.push(
        `wrong height: ${short(txid)}, the seller says block ${claimed}, the chain shows block ${seen.height}${crosses ? ` (on the other side of the close at ${range.closeHeight})` : ""}`,
      );
    }
  }
  add({
    id: "scan-heights",
    level: 3,
    title: "Block heights match the chain",
    status: wrongHeights.length ? "FAIL" : "PASS",
    reason: wrongHeights.length
      ? `${wrongHeights.join("; ")}.`
      : `All ${compared} listed transactions are in the blocks the seller states, so the on-time and late split no longer rests on the seller's word.`,
    fromChain: [...listed].filter(([t]) => all.has(t)).map(([t]) => `${short(t)} in block ${all.get(t)!.height}`),
    fromDisclosure: [...listed].map(([t, h]) => `${short(t)} said to be in block ${h}`),
  });

  // Refund receivers: only provable with the bidder's own key (see SPEC.md).
  const notes: string[] = [];
  const keys = scan.bidderKeys ?? [];
  if (keys.length) {
    const lines: string[] = [];
    const problems: string[] = [];
    for (const k of keys) {
      const bid = k.bidTxid.toLowerCase();
      const wantMemo = `${refPrefix}${bid}`;
      let lotPaid = 0;
      for (const x of all.values()) {
        for (const o of x.outputs) if (o.transferType === "outgoing" && o.memo === wantMemo) lotPaid += o.amountZat;
      }
      let received = 0;
      for (const b of inRange) {
        for (const t of b.txs) {
          let outs: ReadOutput[];
          try {
            outs = readTransactionWithId(t.txHex, k.ufvk).outputs;
          } catch {
            continue; // already reported by scan-blocks-read
          }
          for (const o of outs) if (o.transferType === "incoming" && o.memo === wantMemo) received += o.amountZat;
        }
      }
      if (lotPaid === 0) problems.push(`no refund naming bid ${short(bid)} left the lot in the range`);
      else if (received !== lotPaid) problems.push(`the lot sent ${zat(lotPaid)} for bid ${short(bid)} but the bidder's key received ${zat(received)}`);
      lines.push(`bid ${short(bid)}: lot sent ${zat(lotPaid)}, bidder's key received ${zat(received)}`);
    }
    add({
      id: "scan-refund-receivers",
      level: 3,
      title: "Refunds reached the bidders who gave their key",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length
        ? `${problems.join("; ")}.`
        : `For each of the ${keys.length} bidders who gave their own viewing key, the refund the lot sent for their bid arrived in their wallet in full.`,
      fromChain: lines,
    });
    notes.push(`Refund receivers were proven for ${keys.length} bid(s) whose bidder gave their own key. For other refunds the lot key shows the amount and the memo naming the bid${d.refundAddresses !== undefined ? ", and the check refund-receivers compares where each went with the address in the bid memo or the one the disclosure lists" : ", not who received it"}.`);
  } else if (d.refundAddresses !== undefined || bidMemoHasAddress) {
    notes.push(bidMemoHasAddress ? "Refund receivers were compared with the refund addresses the bidders wrote in their own bid memos (check refund-receivers). The seller could not choose them." : "Refund receivers were compared with the refund addresses the disclosure lists (check refund-receivers). That list is the seller's word: it proves the refunds went where the seller says, and each bidder still has to confirm the address next to their bid is theirs, or add their viewing key with --bidder-keys.");
  } else {
    notes.push("Refund receivers are not proven: the lot key shows each refund's amount and the memo naming its bid, not who received it. The seller can list a refund address per bid (refundAddresses in the disclosure), and a bidder can prove their own refund by adding their viewing key with --bidder-keys.");
  }
  return notes;
}
