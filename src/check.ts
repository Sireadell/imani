import { createHash } from "node:crypto";
import { readTransactionWithId, type ReadOutput } from "./read.ts";
import { decide, type Bid } from "./rules.ts";
import {
  bidMemoPrefix,
  refundMemo,
  refundMemoPrefix,
  type Disclosure,
  type SellerResult,
} from "./files.ts";
import { scanChecks, scanRange, type ScanInput, type ScanRange } from "./scan/scan.ts";
import type { BlockSource } from "./scan/chain.ts";

export type Status = "PASS" | "FAIL";

export interface Check {
  id: string;
  /**
   * 1 = basic level, needs no key. 2 = key level, reads the disclosed payments with the lot key.
   * 3 = scan level, reads every block in the lot's range with the lot key.
   */
  level: 1 | 2 | 3;
  title: string;
  status: Status;
  /** One plain sentence. */
  reason: string;
  /** Numbers read from the transactions with the lot key. */
  fromChain: string[];
  /** Numbers taken from the seller's result file. */
  fromSeller: string[];
  /** Facts taken from the seller's disclosure file without the key (heights, txids, rules). */
  fromDisclosure: string[];
}

export interface Verdict {
  tool: "imani check";
  lotId: string;
  network: string;
  result: Status;
  basicLevel: Status;
  keyLevel: Status | "not run";
  keyLevelNote: string;
  scanLevel: Status | "not run";
  /** Plain sentences about the scan: range, source, time, bytes, what is not proven. */
  scanNotes: string[];
  scanRange: ScanRange | null;
  scanSource: Omit<BlockSource, "serversContacted"> | null;
  /** Short hash of the key so two people can tell they used the same key. Not the key itself. */
  keyFingerprint: string | null;
  serversContacted: string[];
  discreet: boolean;
  failed: string[];
  checks: Check[];
}

export class KeyRefusedError extends Error {}
export class InputError extends Error {}

export interface CheckOptions {
  /** Run only the basic level, even if the disclosure carries a key. */
  basicOnly?: boolean;
  /** Hide amounts and memos in every message. */
  discreet?: boolean;
  /** Run the scan level over these blocks. The caller gets the blocks (chain file or --fetch). */
  scan?: ScanInput;
}

const UFVK_SHAPE = /^uview(test)?1[02-9ac-hj-np-z]+$/;

/**
 * Accept only a unified full viewing key (read-only). Refuse spending keys, seed phrases and
 * anything else. The message never repeats the key.
 */
export function assertViewingKey(key: unknown, network: string): string {
  if (typeof key !== "string" || key.trim() === "") throw new KeyRefusedError("Refused: the lot key is empty or not text.");
  const k = key.trim();
  const words = k.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]+$/i.test(w))) {
    throw new KeyRefusedError(
      "Refused: this looks like a seed phrase. A seed phrase can spend money. Never share it. Disclose only the lot's read-only viewing key (starts with uview1 or uviewtest1).",
    );
  }
  if (/^(secret-extended-key|usk|uskt|zxsk|zxtestsk|xprv|tprv|SK)/i.test(k) || /secret|spend/i.test(k.slice(0, 24))) {
    throw new KeyRefusedError(
      "Refused: this looks like a spending key. A spending key can move the money. Disclose only the lot's read-only viewing key (starts with uview1 or uviewtest1).",
    );
  }
  if (/^uivk/i.test(k)) {
    throw new KeyRefusedError(
      "Refused: this is an incoming-only viewing key. It cannot see refunds. Disclose the lot's full viewing key (starts with uview1 or uviewtest1).",
    );
  }
  if (!UFVK_SHAPE.test(k)) {
    throw new KeyRefusedError(
      "Refused: the lot key is not a unified full viewing key. Only keys that start with uview1 (main network) or uviewtest1 (test network) are accepted.",
    );
  }
  const keyNetwork = k.startsWith("uviewtest1") ? "test" : "main";
  if (keyNetwork !== network) {
    throw new KeyRefusedError(`Refused: the lot key is for the ${keyNetwork} network but the disclosure says ${network}.`);
  }
  return k;
}

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isAmount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const isTxid = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

/** Check the shape of both files before any check runs, so a broken file gives a clear message. */
export function validateFiles(d: any, r: any): asserts d is Disclosure {
  const bad = (what: string) => {
    throw new InputError(`Input error: ${what}`);
  };
  if (!d || typeof d !== "object") bad("the disclosure file is not a JSON object.");
  if (d.format !== "imani-lot-disclosure/1") bad('the disclosure file must have "format": "imani-lot-disclosure/1".');
  if (typeof d.lotId !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(d.lotId)) bad("lotId must be 1 to 40 letters, digits, dots, dashes or underscores.");
  if (d.network !== "main" && d.network !== "test") bad('network must be "main" or "test".');
  if (!d.rules || typeof d.rules !== "object") bad("the disclosure file needs rules (itemCount, reserveZat).");
  if (!Array.isArray(d.transactions)) bad("the disclosure file needs a transactions list.");
  for (const t of d.transactions) {
    if (!t || typeof t.txHex !== "string" || !/^([0-9a-f]{2})+$/i.test(t.txHex)) bad("every disclosed transaction needs txHex (hex text).");
  }
  if (!r || typeof r !== "object") bad("the result file is not a JSON object.");
  if (r.format !== "imani-lot-result/1") bad('the result file must have "format": "imani-lot-result/1".');
  if (!Array.isArray(r.bids) || !Array.isArray(r.winners) || !Array.isArray(r.refunds)) bad("the result file needs bids, winners and refunds lists.");
}

/** Run every check. Never prints, never writes files, never contacts a server. */
export function checkLot(d: Disclosure, r: SellerResult, opts: CheckOptions = {}): Verdict {
  validateFiles(d, r);
  const discreet = !!opts.discreet;
  const zat = (n: number) => (discreet ? "[hidden]" : `${n.toLocaleString("en-US")} zat`);
  const memo = (m: string) => (discreet ? "[hidden]" : JSON.stringify(m));
  const short = (t: string) => (typeof t === "string" ? t.slice(0, 10) : String(t));
  const checks: Check[] = [];
  const add = (c: Omit<Check, "fromChain" | "fromSeller" | "fromDisclosure"> & Partial<Check>) =>
    checks.push({ fromChain: [], fromSeller: [], fromDisclosure: [], ...c });

  // ---------------- Basic level: no key needed ----------------
  const heightsOk =
    isAmount(d.closeHeight) && d.transactions.every((t) => isAmount(t.height));
  add({
    id: "close-height",
    level: 1,
    title: "Close height is valid",
    status: heightsOk ? "PASS" : "FAIL",
    reason: heightsOk
      ? `The lot closes at block ${d.closeHeight} and every disclosed transaction has a block height.`
      : "The close height or a transaction height is missing or not a whole positive number.",
    fromDisclosure: [`close height ${d.closeHeight}`, `${d.transactions.length} transactions with heights`],
  });

  const seen = new Set<string>();
  const dupTx: string[] = [];
  for (const t of d.transactions) {
    if (seen.has(t.txid)) dupTx.push(t.txid);
    seen.add(t.txid);
  }
  const txidsOk = dupTx.length === 0 && d.transactions.every((t) => isTxid(t.txid));
  add({
    id: "disclosure-txids-unique",
    level: 1,
    title: "Disclosed transaction ids are unique",
    status: txidsOk ? "PASS" : "FAIL",
    reason: txidsOk
      ? `All ${d.transactions.length} disclosed transaction ids are different.`
      : dupTx.length
        ? `The same transaction is listed more than once: ${dupTx.map(short).join(", ")}.`
        : "A disclosed transaction id is not 64 hex characters.",
    fromDisclosure: [`${d.transactions.length} transaction ids`],
  });

  const problems: string[] = [];
  const rulesOk =
    isAmount(d.rules.itemCount) && isCount(d.rules.reserveZat) && r.rules &&
    r.rules.itemCount === d.rules.itemCount && r.rules.reserveZat === d.rules.reserveZat;
  if (r.lotId !== d.lotId) problems.push(`the result is for lot ${r.lotId}, the disclosure for lot ${d.lotId}`);
  if (!rulesOk) problems.push("the rules (item count, reserve) in the result differ from the disclosure");
  if (r.bidCount !== r.bids.length) problems.push(`bidCount says ${r.bidCount} but ${r.bids.length} bids are listed`);
  const listed = new Map<string, number>();
  for (const b of r.bids) {
    if (!isTxid(b.txid) || !isAmount(b.amountZat)) problems.push("a listed bid has a bad txid or amount");
    else if (listed.has(b.txid)) problems.push(`bid ${short(b.txid)} is listed twice`);
    else listed.set(b.txid, b.amountZat);
  }
  const winnerSet = new Set(r.winners);
  if (winnerSet.size !== r.winners.length) problems.push("a winner is listed twice");
  for (const w of r.winners) if (!listed.has(w)) problems.push(`winner ${short(w)} is not in the bid list`);
  if (r.reserveMet !== (r.winners.length > 0)) problems.push("reserveMet does not agree with the winners list");
  const refundsByBid = new Map<string, number>();
  for (const f of r.refunds) {
    if (!isTxid(f.bidTxid) || !isAmount(f.amountZat)) problems.push("a listed refund has a bad bid txid or amount");
    else if (f.memo !== refundMemo(r.lotId, f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} does not carry the memo "refund:<lot>:<bid txid>"`);
    else if (f.reason !== "late" && !listed.has(f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} points to a bid that is not listed`);
    else if (f.reason === "change" && !winnerSet.has(f.bidTxid)) problems.push(`change refund for ${short(f.bidTxid)} but that bid did not win`);
    refundsByBid.set(f.bidTxid, (refundsByBid.get(f.bidTxid) ?? 0) + (f.amountZat || 0));
  }
  for (const [txid, amount] of listed) {
    if (!winnerSet.has(txid) && refundsByBid.get(txid) !== amount) {
      problems.push(`losing bid ${short(txid)} is not listed as refunded in full`);
    }
  }
  if (!isCount(r.clearingPriceZat)) problems.push("the clearing price is not a whole number");
  add({
    id: "result-consistent",
    level: 1,
    title: "Seller's result file is consistent with itself",
    status: problems.length ? "FAIL" : "PASS",
    reason: problems.length
      ? `The result file contradicts itself: ${problems.join("; ")}.`
      : "Bid count, winners, reserve and refunds in the result file agree with each other and with the published rules.",
    fromSeller: [`${r.bidCount} bids`, `${r.winners.length} winners`, `${r.refunds.length} refunds`],
    fromDisclosure: [`rules: ${d.rules.itemCount} items, reserve ${zat(d.rules.reserveZat)}`],
  });

  const winnerCountOk = r.winners.length <= Math.min(d.rules.itemCount, r.bids.length);
  add({
    id: "winner-count",
    level: 1,
    title: "Winner count fits the lot",
    status: winnerCountOk ? "PASS" : "FAIL",
    reason: winnerCountOk
      ? `${r.winners.length} winners, no more than the ${d.rules.itemCount} items and the ${r.bids.length} bids.`
      : `${r.winners.length} winners is more than the ${d.rules.itemCount} items or the ${r.bids.length} bids.`,
    fromSeller: [`${r.winners.length} winners`, `${r.bids.length} bids`],
    fromDisclosure: [`${d.rules.itemCount} items`],
  });

  const highest = Math.max(0, ...r.bids.map((b) => b.amountZat || 0));
  const priceOk = r.winners.length
    ? r.clearingPriceZat >= d.rules.reserveZat && r.clearingPriceZat <= highest
    : r.clearingPriceZat === 0;
  add({
    id: "clearing-range",
    level: 1,
    title: "Clearing price is between the reserve and the highest bid",
    status: priceOk ? "PASS" : "FAIL",
    reason: priceOk
      ? r.winners.length
        ? `Clearing price ${zat(r.clearingPriceZat)} is not below the reserve ${zat(d.rules.reserveZat)} and not above the highest listed bid ${zat(highest)}.`
        : "No winners, and the clearing price is 0."
      : r.winners.length
        ? `Clearing price ${zat(r.clearingPriceZat)} is outside the range from the reserve ${zat(d.rules.reserveZat)} to the highest listed bid ${zat(highest)}.`
        : "There are no winners but the clearing price is not 0.",
    fromSeller: [`clearing price ${zat(r.clearingPriceZat)}`, `highest listed bid ${zat(highest)}`],
    fromDisclosure: [`reserve ${zat(d.rules.reserveZat)}`],
  });

  const basicLevel: Status = checks.every((c) => c.status === "PASS") ? "PASS" : "FAIL";

  // ---------------- Key level: read the lot's payments with the lot key ----------------
  let keyLevel: Status | "not run" = "not run";
  let keyLevelNote = "";
  let fingerprint: string | null = null;
  if (opts.basicOnly) {
    keyLevelNote = "Basic level only was asked for. The key level was not run.";
  } else if (d.ufvk === undefined || d.ufvk === null || d.ufvk === "") {
    keyLevelNote = "The disclosure has no lot key, so only the basic level ran.";
  } else {
    const key = assertViewingKey(d.ufvk, d.network);
    fingerprint = keyFingerprint(key);
    keyChecks(d, r, key, add, zat, memo, short);
    keyLevel = checks.filter((c) => c.level === 2).every((c) => c.status === "PASS") ? "PASS" : "FAIL";
    keyLevelNote = "Amounts, memos and refunds were read from the disclosed transactions with the lot key.";
  }

  // ---------------- Scan level: read every block in the lot's range ----------------
  let scanLevel: Status | "not run" = "not run";
  let scanNotes: string[] = [];
  let range: ScanRange | null = null;
  let scanSource: Verdict["scanSource"] = null;
  if (opts.scan) {
    const { serversContacted: _s, ...src } = opts.scan.source;
    scanSource = src;
    if (keyLevel === "not run") {
      scanNotes = ["The scan level needs the lot key and the key level, so it was not run."];
    } else {
      range = scanRange(d, opts.scan.graceBlocks);
      const key = assertViewingKey(d.ufvk, d.network);
      scanNotes = scanChecks(d, key, opts.scan, add, zat, memo, short);
      scanLevel = checks.filter((c) => c.level === 3).every((c) => c.status === "PASS") ? "PASS" : "FAIL";
    }
  }

  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  return {
    tool: "imani check",
    lotId: d.lotId,
    network: d.network,
    result: failed.length ? "FAIL" : "PASS",
    basicLevel,
    keyLevel,
    keyLevelNote,
    scanLevel,
    scanNotes,
    scanRange: range,
    scanSource,
    keyFingerprint: fingerprint,
    serversContacted: opts.scan ? [...opts.scan.source.serversContacted] : [],
    discreet,
    failed,
    checks,
  };
}

interface ChainBid extends Bid {
  memo: string;
  outputs: number;
}

function keyChecks(
  d: Disclosure,
  r: SellerResult,
  key: string,
  add: (c: Omit<Check, "fromChain" | "fromSeller" | "fromDisclosure"> & Partial<Check>) => void,
  zat: (n: number) => string,
  memo: (m: string) => string,
  short: (t: string) => string,
) {
  // Read every disclosed transaction with the lot key.
  const read: { txid: string; listedTxid: string; height: number; outputs: ReadOutput[] }[] = [];
  for (const t of d.transactions) {
    let res;
    try {
      res = readTransactionWithId(t.txHex, key);
    } catch (e) {
      // Decoder messages must never carry the key.
      const msg = String((e as Error)?.message ?? e).split(key).join("[key]");
      throw new InputError(`Input error: transaction ${short(t.txid)} could not be read (${msg}).`);
    }
    read.push({ txid: res.txid, listedTxid: t.txid, height: t.height, outputs: res.outputs });
  }

  const wrongIds = read.filter((x) => x.txid !== x.listedTxid);
  add({
    id: "txids-match-bytes",
    level: 2,
    title: "Transaction ids match the transaction bytes",
    status: wrongIds.length ? "FAIL" : "PASS",
    reason: wrongIds.length
      ? `${wrongIds.length} listed transaction ids do not match their bytes: ${wrongIds.map((x) => short(x.listedTxid)).join(", ")}.`
      : `Each of the ${read.length} transaction ids was recomputed from the bytes and matches.`,
    fromChain: [`${read.length} transaction ids recomputed from the bytes`],
  });

  // Sort what the key sees into bids, refunds and anything else.
  const bidPrefix = bidMemoPrefix(d.lotId);
  const refPrefix = refundMemoPrefix(d.lotId);
  const bids = new Map<string, ChainBid>();
  const outside: { txid: string; amountZat: number; memo: string }[] = [];
  const refunds: { txid: string; bidTxid: string; amountZat: number }[] = [];
  for (const x of read) {
    for (const o of x.outputs) {
      if (o.transferType === "incoming") {
        if (o.memo.startsWith(bidPrefix)) {
          const prev = bids.get(x.txid);
          if (prev) {
            prev.amountZat += o.amountZat;
            prev.outputs += 1;
          } else {
            bids.set(x.txid, { txid: x.txid, amountZat: o.amountZat, height: x.height, memo: o.memo, outputs: 1 });
          }
        } else {
          outside.push({ txid: x.txid, amountZat: o.amountZat, memo: o.memo });
        }
      } else if (o.transferType === "outgoing" && o.memo.startsWith(refPrefix)) {
        refunds.push({ txid: x.txid, bidTxid: o.memo.slice(refPrefix.length), amountZat: o.amountZat });
      }
      // "internal" outputs are the lot's own change and are not counted.
    }
  }
  // A bid memo used again in a later transaction is a replay: it is not a new bid. It is
  // reported by the duplicate check and, like a late bid, owed back in full.
  const firstByMemo = new Map<string, ChainBid>();
  const replays: ChainBid[] = [];
  for (const b of [...bids.values()].sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : 1))) {
    if (firstByMemo.has(b.memo)) replays.push(b);
    else firstByMemo.set(b.memo, b);
  }
  const allBids = [...firstByMemo.values()];
  const onTime = allBids.filter((b) => b.height <= d.closeHeight);
  const late = allBids.filter((b) => b.height > d.closeHeight);
  const lateIds = new Set(late.map((b) => b.txid));

  add({
    id: "key-hygiene",
    level: 2,
    title: "Lot key shows only this lot's payments",
    status: outside.length ? "FAIL" : "PASS",
    reason: outside.length
      ? `The key shows ${outside.length} payment(s) into this address that are not bids for ${d.lotId}. Publishing this key exposes them. Use a fresh one-time key for every lot.`
      : `Every incoming payment the key shows is a bid for ${d.lotId}.`,
    fromChain: outside.map((o) => `outside payment ${short(o.txid)}: ${zat(o.amountZat)}, memo ${memo(o.memo)}`),
  });

  // Bid count: the seller's listed bids (leaving out late bids, which the late-bid check judges)
  // must be exactly the on-time bids the key shows.
  const sellerIds = r.bids.map((b) => b.txid).filter((t) => !lateIds.has(t));
  const onTimeIds = new Set(onTime.map((b) => b.txid));
  const notOnChain = sellerIds.filter((t) => !onTimeIds.has(t));
  const notListed = [...onTimeIds].filter((t) => !sellerIds.includes(t));
  const countOk = notOnChain.length === 0 && notListed.length === 0 && sellerIds.length === onTime.length;
  add({
    id: "bid-count",
    level: 2,
    title: "Bid count matches the chain",
    status: countOk ? "PASS" : "FAIL",
    reason: countOk
      ? `The seller lists ${sellerIds.length} on-time bids and the key shows the same ${onTime.length}.`
      : [
          `The seller lists ${sellerIds.length} on-time bids, the key shows ${onTime.length}.`,
          notOnChain.length ? `Not found on the chain: ${notOnChain.map(short).join(", ")}.` : "",
          notListed.length ? `Missing from the seller's list: ${notListed.map(short).join(", ")}.` : "",
        ].filter(Boolean).join(" "),
    fromChain: [`${onTime.length} on-time bid payments`],
    fromSeller: [`${sellerIds.length} on-time bids listed`],
  });

  const wrongAmounts: string[] = [];
  for (const b of r.bids) {
    const c = bids.get(b.txid);
    if (c && c.amountZat !== b.amountZat) wrongAmounts.push(`${short(b.txid)}: seller says ${zat(b.amountZat)}, chain shows ${zat(c.amountZat)}`);
  }
  add({
    id: "bid-amounts",
    level: 2,
    title: "Each bid amount matches the chain",
    status: wrongAmounts.length ? "FAIL" : "PASS",
    reason: wrongAmounts.length
      ? `${wrongAmounts.length} bid amount(s) differ: ${wrongAmounts.join("; ")}.`
      : "Every listed bid amount equals the amount the key reads from the chain.",
    fromChain: allBids.map((b) => `bid ${short(b.txid)}: ${zat(b.amountZat)}`),
    fromSeller: r.bids.map((b) => `bid ${short(b.txid)}: ${zat(b.amountZat)}`),
  });

  const countedLate = r.bids.filter((b) => lateIds.has(b.txid));
  add({
    id: "no-late-bids",
    level: 2,
    title: "No bid after the close was counted",
    status: countedLate.length ? "FAIL" : "PASS",
    reason: countedLate.length
      ? `The seller counted ${countedLate.length} bid(s) paid after the close at block ${d.closeHeight}: ${countedLate.map((b) => `${short(b.txid)} at block ${bids.get(b.txid)!.height}`).join(", ")}.`
      : late.length
        ? `${late.length} bid(s) arrived after block ${d.closeHeight} and the seller did not count them.`
        : `No bid arrived after block ${d.closeHeight}.`,
    fromChain: late.map((b) => `late bid ${short(b.txid)}: ${zat(b.amountZat)}`),
    fromDisclosure: [`close height ${d.closeHeight}`, ...late.map((b) => `bid ${short(b.txid)} at block ${b.height}`)],
  });

  const memoCount = new Map<string, string[]>();
  for (const b of [...allBids, ...replays]) memoCount.set(b.memo, [...(memoCount.get(b.memo) ?? []), b.txid]);
  const dupMemos = [...memoCount.values()].filter((ids) => ids.length > 1);
  const multi = allBids.filter((b) => b.outputs > 1);
  const dupOk = dupMemos.length === 0 && multi.length === 0;
  add({
    id: "no-duplicate-bids",
    level: 2,
    title: "No duplicate or replayed bid",
    status: dupOk ? "PASS" : "FAIL",
    reason: dupOk
      ? "Every bid memo is used once and every bid transaction holds one bid."
      : [
          ...dupMemos.map((ids) => `The same bid memo appears in ${ids.length} transactions (${ids.map(short).join(", ")}), a replayed bid.`),
          ...multi.map((b) => `Transaction ${short(b.txid)} holds ${b.outputs} bids.`),
        ].join(" "),
    fromChain: [`${allBids.length + replays.length} bid payments`, `${replays.length} replayed`],
  });

  const outcome = decide(onTime, d.rules);
  const sameWinners =
    outcome.winners.length === r.winners.length && outcome.winners.every((w) => r.winners.includes(w));
  const samePrice = outcome.clearingPriceZat === r.clearingPriceZat;
  add({
    id: "winners-and-price",
    level: 2,
    title: "Winners and clearing price recomputed from the chain",
    status: sameWinners && samePrice ? "PASS" : "FAIL",
    reason:
      sameWinners && samePrice
        ? `Recomputed from the on-time bids: winners ${outcome.winners.map(short).join(", ") || "none"}, clearing price ${zat(outcome.clearingPriceZat)}. Same as the seller.`
        : [
            !sameWinners ? `Winners should be ${outcome.winners.map(short).join(", ") || "none"}, the seller says ${r.winners.map(short).join(", ") || "none"}.` : "",
            !samePrice ? `Clearing price should be ${zat(outcome.clearingPriceZat)}, the seller says ${zat(r.clearingPriceZat)}.` : "",
          ].filter(Boolean).join(" "),
    fromChain: [`winners ${outcome.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(outcome.clearingPriceZat)}`],
    fromSeller: [`winners ${r.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(r.clearingPriceZat)}`],
    fromDisclosure: [`${d.rules.itemCount} items, reserve ${zat(d.rules.reserveZat)}`],
  });

  add({
    id: "reserve",
    level: 2,
    title: "Reserve outcome",
    status: outcome.reserveMet === r.reserveMet ? "PASS" : "FAIL",
    reason:
      outcome.reserveMet === r.reserveMet
        ? `The reserve was ${outcome.reserveMet ? "" : "not "}met, as the seller says.`
        : `The seller says the reserve was ${r.reserveMet ? "" : "not "}met, the chain says it was ${outcome.reserveMet ? "" : "not "}met.`,
    fromChain: [`reserve met: ${outcome.reserveMet}`],
    fromSeller: [`reserve met: ${r.reserveMet}`],
  });

  // Refunds owed, all worked out from the chain: on-time bids by the rule, late bids in full.
  const owed = new Map(outcome.refundsOwed);
  for (const b of [...late, ...replays]) owed.set(b.txid, b.amountZat);
  const paid = new Map<string, number>();
  for (const f of refunds) paid.set(f.bidTxid, (paid.get(f.bidTxid) ?? 0) + f.amountZat);
  const refundProblems: string[] = [];
  for (const [txid, amount] of owed) {
    if (amount === 0) continue;
    const got = paid.get(txid);
    if (got === undefined) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but no refund was found`);
    else if (got !== amount) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but was refunded ${zat(got)}`);
  }
  const owedCount = [...owed.values()].filter((a) => a > 0).length;
  add({
    id: "refunds-paid",
    level: 2,
    title: "Every refund paid in the exact amount",
    status: refundProblems.length ? "FAIL" : "PASS",
    reason: refundProblems.length
      ? `${refundProblems.length} refund problem(s): ${refundProblems.join("; ")}.`
      : `All ${owedCount} refunds owed (losers in full, winners their bid minus the clearing price, late bids in full) were paid exactly, each with a memo naming its bid.`,
    fromChain: [
      ...[...owed].filter(([, a]) => a > 0).map(([t, a]) => `owed to ${short(t)}: ${zat(a)}`),
      ...refunds.map((f) => `refund for ${short(f.bidTxid)}: ${zat(f.amountZat)}`),
    ],
  });

  // Refund total: the seller's books must balance against what the chain shows came in.
  // Rule: refunds the seller lists (for bids the key can see) + clearing price x winners
  //       = total bid payments received - fee allowance. The fee allowance is 0: network fees
  //       are paid by the seller on top, never out of bidders' money.
  const received = [...allBids, ...replays].reduce((s, b) => s + b.amountZat, 0);
  const sellerRefunds = r.refunds.filter((f) => bids.has(f.bidTxid)).reduce((s, f) => s + f.amountZat, 0);
  const kept = r.clearingPriceZat * r.winners.length;
  const FEE_ALLOWANCE = 0;
  const totalOk = sellerRefunds + kept === received - FEE_ALLOWANCE;
  add({
    id: "refund-total",
    level: 2,
    title: "Refund total balances",
    status: totalOk ? "PASS" : "FAIL",
    reason: totalOk
      ? `Refunds ${zat(sellerRefunds)} plus winners' payments ${zat(kept)} equal the ${zat(received)} received, with no fees taken from bidders.`
      : `Refunds ${zat(sellerRefunds)} plus winners' payments ${zat(kept)} make ${zat(sellerRefunds + kept)}, but ${zat(received)} was received. The difference is ${zat(Math.abs(received - sellerRefunds - kept))}.`,
    fromChain: [`received ${zat(received)}`],
    fromSeller: [`refunds listed ${zat(sellerRefunds)}`, `winners' payments ${zat(kept)}`],
  });
}
