import { createHash } from "node:crypto";
import { parseAddress, readTransactionWithId, type ParsedAddress, type ReadOutput } from "./read.ts";
import { decide, groupBidPayments, type Bid } from "./rules.ts";
import {
  bidMemoAddress,
  bidMemoPrefix,
  refundMemo,
  refundMemoPrefix,
  openMemoPrefix,
  parseOpenMemo,
  parseSealMemo,
  sealMemoPrefix,
  type AuctionRules,
  type Disclosure,
  type SellerResult,
} from "./files.ts";
import { scanChecks, scanRange, type ScanInput, type ScanRange } from "./scan/scan.ts";
import type { BlockSource } from "./scan/chain.ts";
import { openSeals, type OpenFact, type SealFact } from "./sealed.ts";

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
  /** Sealed lots only: what the seals and openings came to. Absent for other lots. */
  sealed?: SealedSummary;
  failed: string[];
  checks: Check[];
}

export interface SealedSummary {
  seals: number;
  counted: number;
  /** Seals never opened in the window. */
  unopened: number;
  /** Seals opened with a price that does not match, or above the deposit. */
  badlyOpened: number;
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
  if (!d.rules || typeof d.rules !== "object") bad("the disclosure file needs rules (itemCount and reserveZat, or kind goal with goalZat).");
  if (d.rules.kind !== undefined && d.rules.kind !== "auction" && d.rules.kind !== "goal" && d.rules.kind !== "sealed") bad('the rules kind must be "auction", "goal" or "sealed".');
  if (d.rules.kind === "sealed") {
    const q = d.rules;
    if (!isAmount(q.itemCount) || !isCount(q.reserveZat)) bad("a sealed lot needs itemCount (above 0) and reserveZat in its rules.");
    if (!isAmount(q.depositZat)) bad("a sealed lot needs a deposit (depositZat) above 0 in its rules.");
    if (!isCount(q.forfeitZat) || q.forfeitZat > q.depositZat) bad("the penalty (forfeitZat) of a sealed lot must be a whole number from 0 up to the deposit.");
    if (q.reserveZat > q.depositZat) bad("the reserve of a sealed lot cannot be higher than the deposit.");
    if (!isAmount(d.openByHeight)) bad("a sealed lot needs openByHeight, the last block at which a seal can be opened.");
    if (isAmount(d.closeHeight) && d.openByHeight <= d.closeHeight) bad("openByHeight must be greater than closeHeight.");
    if (d.refundByHeight !== undefined && isAmount(d.refundByHeight) && d.openByHeight > d.refundByHeight) bad("openByHeight cannot be after refundByHeight.");
  }
  if (d.rules.kind === undefined || d.rules.kind === "auction") {
    if (d.rules.pricing !== undefined && d.rules.pricing !== "highest-losing" && d.rules.pricing !== "lowest-winning") bad('the pricing rule must be "highest-losing" or "lowest-winning".');
    if (d.rules.topUps !== undefined && typeof d.rules.topUps !== "boolean") bad("topUps in the rules must be true or false.");
  }
  if (d.rules.kind === "goal" && !isAmount(d.rules.goalZat)) bad("the goal in the rules (goalZat) must be a whole number above 0.");
  if (!Array.isArray(d.transactions)) bad("the disclosure file needs a transactions list.");
  for (const t of d.transactions) {
    if (!t || typeof t.txHex !== "string" || !/^([0-9a-f]{2})+$/i.test(t.txHex)) bad("every disclosed transaction needs txHex (hex text).");
  }
  if (d.refundAddresses !== undefined) {
    if (!Array.isArray(d.refundAddresses)) bad("refundAddresses must be a list of { bidTxid, address }.");
    for (const a of d.refundAddresses) {
      if (!a || !isTxid(a.bidTxid) || typeof a.address !== "string" || a.address.trim() === "") bad("every refundAddresses entry needs a 64 hex character bidTxid and an address.");
    }
  }
  if (!r || typeof r !== "object") bad("the result file is not a JSON object.");
  if (r.format !== "imani-lot-result/1") bad('the result file must have "format": "imani-lot-result/1".');
  if (!Array.isArray(r.bids) || !Array.isArray(r.winners) || !Array.isArray(r.refunds)) bad("the result file needs bids, winners and refunds lists.");
  if (!r.bids.every((b: unknown) => b && typeof b === "object")) bad("every entry in bids needs to be an object with a txid and amountZat.");
  if (!r.refunds.every((x: unknown) => x && typeof x === "object")) bad("every entry in refunds needs to be an object with a bidTxid and amountZat.");
  if (r.totals !== undefined) {
    const t = r.totals as unknown as Record<string, unknown>;
    if (!t || typeof t !== "object" || !(["payments", "receivedZat", "keptZat", "refundedZat"] as const).every((k) => isCount(t[k]))) bad("totals in the result file needs payments, receivedZat, keptZat and refundedZat, each a whole number from 0 up.");
  }
  if (r.unopened !== undefined && (!Array.isArray(r.unopened) || !r.unopened.every(isTxid))) bad("unopened in the result file must be a list of 64 hex character transaction ids.");
}

/** Run every check. Never prints, never writes files, never contacts a server. */
export function checkLot(d: Disclosure, r: SellerResult, opts: CheckOptions = {}): Verdict {
  validateFiles(d, r);
  const discreet = !!opts.discreet;
  const zat = (n: number) => (discreet ? "[hidden]" : typeof n === "number" ? `${n.toLocaleString("en-US")} zat` : `${String(n)} zat`);
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
  const goalRules = d.rules.kind === "goal" ? d.rules : null;
  const sealedBasic = d.rules.kind === "sealed" ? d.rules : null;
  const ar = d.rules as AuctionRules; // only read when goalRules is null
  const rulesOk = goalRules
    ? !!r.rules && r.rules.kind === "goal" && r.rules.goalZat === goalRules.goalZat
    : sealedBasic
      ? !!r.rules && r.rules.kind === "sealed" && r.rules.itemCount === sealedBasic.itemCount && r.rules.reserveZat === sealedBasic.reserveZat &&
        r.rules.depositZat === sealedBasic.depositZat && r.rules.forfeitZat === sealedBasic.forfeitZat
      : isAmount(ar.itemCount) && isCount(ar.reserveZat) && r.rules && r.rules.kind !== "goal" && r.rules.kind !== "sealed" &&
      (r.rules as AuctionRules).itemCount === ar.itemCount && (r.rules as AuctionRules).reserveZat === ar.reserveZat &&
      (r.rules as AuctionRules).pricing === ar.pricing && (r.rules as AuctionRules).topUps === ar.topUps;
  if (r.lotId !== d.lotId) problems.push(`the result is for lot ${r.lotId}, the disclosure for lot ${d.lotId}`);
  if (!rulesOk) problems.push(goalRules ? "the rules (goal) in the result differ from the disclosure" : sealedBasic ? "the rules (item count, reserve, deposit, penalty) in the result differ from the disclosure" : "the rules (item count, reserve, pricing, top-ups) in the result differ from the disclosure");
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
    if (goalRules && winnerSet.has(f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} but a payment counted towards a reached goal is kept, never refunded`);
    if (!isTxid(f.bidTxid) || !isAmount(f.amountZat)) problems.push("a listed refund has a bad bid txid or amount");
    else if (f.memo !== refundMemo(r.lotId, f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} does not carry the memo "refund:<lot>:<bid txid>"`);
    else if (f.reason !== "late" && !(sealedBasic && (f.reason === "unopened" || f.reason === "bad-opening" || f.reason === "opening")) && !listed.has(f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} points to a bid that is not listed`);
    else if (f.reason === "change" && !winnerSet.has(f.bidTxid)) problems.push(`change refund for ${short(f.bidTxid)} but that bid did not win`);
    refundsByBid.set(f.bidTxid, (refundsByBid.get(f.bidTxid) ?? 0) + (f.amountZat || 0));
  }
  for (const [txid, amount] of listed) {
    if (sealedBasic) {
      if (!winnerSet.has(txid) && refundsByBid.get(txid) === undefined) problems.push(`losing bid ${short(txid)} has no refund listed`);
    } else if (!winnerSet.has(txid) && refundsByBid.get(txid) !== amount) {
      problems.push(`losing bid ${short(txid)} is not listed as refunded in full`);
    }
  }
  if (!isCount(r.clearingPriceZat)) problems.push("the clearing price is not a whole number");
  if (goalRules && r.clearingPriceZat !== 0) problems.push("a goal round has no price, so the clearing price must be 0");
  if (goalRules && r.winners.length > 0 && r.winners.length !== r.bids.length) problems.push("when the goal is reached every listed payment counts, but some are not marked as counted");
  add({
    id: "result-consistent",
    level: 1,
    title: "Seller's result file is consistent with itself",
    status: problems.length ? "FAIL" : "PASS",
    reason: problems.length
      ? `The result file contradicts itself: ${problems.join("; ")}.`
      : goalRules
        ? "Payment count, counted payments, goal outcome and refunds in the result file agree with each other and with the published goal."
        : "Bid count, winners, reserve and refunds in the result file agree with each other and with the published rules.",
    fromSeller: goalRules
      ? [`${r.bidCount} payments`, `${r.winners.length} counted`, `${r.refunds.length} refunds`]
      : [`${r.bidCount} bids`, `${r.winners.length} winners`, `${r.refunds.length} refunds`],
    fromDisclosure: [goalRules ? `rules: goal ${zat(goalRules.goalZat)}` : sealedBasic ? `rules: sealed lot, ${ar.itemCount} items, reserve ${zat(ar.reserveZat)}, deposit ${zat(sealedBasic.depositZat)}, penalty ${zat(sealedBasic.forfeitZat)}` : `rules: ${ar.itemCount} items, reserve ${zat(ar.reserveZat)}`],
  });

  if (goalRules) {
    const listedTotal = r.bids.reduce((s, b) => s + (b.amountZat || 0), 0);
    const reachedByList = r.bids.length > 0 && listedTotal >= goalRules.goalZat;
    const goalOk = reachedByList === r.reserveMet;
    add({
      id: "goal-reached",
      level: 1,
      title: "The goal outcome matches the listed payments",
      status: goalOk ? "PASS" : "FAIL",
      reason: goalOk
        ? `The listed payments add up to ${zat(listedTotal)} against a goal of ${zat(goalRules.goalZat)}: the goal was ${reachedByList ? "" : "not "}reached, as the seller says.`
        : `The listed payments add up to ${zat(listedTotal)} against a goal of ${zat(goalRules.goalZat)}, so the goal was ${reachedByList ? "" : "not "}reached, but the seller says it was ${r.reserveMet ? "" : "not "}reached.`,
      fromSeller: [`listed payments ${zat(listedTotal)}`, `goal reached: ${r.reserveMet}`],
      fromDisclosure: [`goal ${zat(goalRules.goalZat)}`],
    });
  }

  const winnerCountOk = goalRules ? r.winners.length === 0 || r.winners.length === r.bids.length : r.winners.length <= Math.min(ar.itemCount, r.bids.length);
  add({
    id: "winner-count",
    level: 1,
    title: goalRules ? "Either every payment counts or none does" : "Winner count fits the lot",
    status: winnerCountOk ? "PASS" : "FAIL",
    reason: goalRules
      ? winnerCountOk
        ? r.winners.length ? `All ${r.winners.length} listed payments count towards the goal.` : "The goal was not reached, so no payment counts."
        : `${r.winners.length} of ${r.bids.length} listed payments are marked as counted, but a reached goal counts all of them.`
      : winnerCountOk
        ? `${r.winners.length} winners, no more than the ${ar.itemCount} items and the ${r.bids.length} bids.`
        : `${r.winners.length} winners is more than the ${ar.itemCount} items or the ${r.bids.length} bids.`,
    fromSeller: goalRules ? [`${r.winners.length} counted`, `${r.bids.length} payments`] : [`${r.winners.length} winners`, `${r.bids.length} bids`],
    fromDisclosure: goalRules ? [`goal ${zat(goalRules.goalZat)}`] : [`${ar.itemCount} items`],
  });

  const highest = Math.max(0, ...r.bids.map((b) => b.amountZat || 0));
  const lowestWinning = !goalRules && !sealedBasic && ar.pricing === "lowest-winning";
  const listedAmount = new Map(r.bids.map((b) => [b.txid, b.amountZat]));
  const lowestListedWinner = Math.min(...r.winners.map((w) => listedAmount.get(w) ?? Infinity));
  const priceOk = goalRules
    ? r.clearingPriceZat === 0
    : r.winners.length
      ? r.clearingPriceZat >= ar.reserveZat && r.clearingPriceZat <= highest && (!lowestWinning || r.clearingPriceZat === Math.max(ar.reserveZat, lowestListedWinner))
      : r.clearingPriceZat === 0;
  add({
    id: "clearing-range",
    level: 1,
    title: goalRules ? "No price is set in a goal round" : "Clearing price is between the reserve and the highest bid",
    status: priceOk ? "PASS" : "FAIL",
    reason: goalRules
      ? priceOk
        ? "Payments are kept at their own amount, so no price is set (0 in the file)."
        : `Payments are kept at their own amount, so no price should be set, but the file sets ${zat(r.clearingPriceZat)}.`
      : priceOk
        ? r.winners.length
          ? lowestWinning
            ? `Clearing price ${zat(r.clearingPriceZat)} is the lowest listed winning bid, as the lowest-winning rule says.`
            : `Clearing price ${zat(r.clearingPriceZat)} is not below the reserve ${zat(ar.reserveZat)} and not above the highest listed bid ${zat(highest)}.`
          : "No winners, and the clearing price is 0."
        : r.winners.length
          ? lowestWinning && r.clearingPriceZat >= ar.reserveZat && r.clearingPriceZat <= highest
            ? `Clearing price ${zat(r.clearingPriceZat)} is not the lowest listed winning bid ${zat(Math.max(ar.reserveZat, lowestListedWinner))}, which the lowest-winning rule requires.`
            : `Clearing price ${zat(r.clearingPriceZat)} is outside the range from the reserve ${zat(ar.reserveZat)} to the highest listed bid ${zat(highest)}.`
          : "There are no winners but the clearing price is not 0.",
    fromSeller: goalRules ? [`price ${zat(r.clearingPriceZat)}`] : [`clearing price ${zat(r.clearingPriceZat)}`, `highest listed bid ${zat(highest)}`],
    fromDisclosure: [goalRules ? "no price in a goal round" : `reserve ${zat(ar.reserveZat)}`],
  });

  if (r.totals) {
    const t = r.totals;
    const listedRefunds = r.refunds.reduce((s, f) => s + (f.amountZat || 0), 0);
    const keptByRule = goalRules ? r.winners.reduce((s, w) => s + (listedAmount.get(w) ?? 0), 0) : r.clearingPriceZat * r.winners.length;
    const problems: string[] = [];
    if (t.receivedZat !== t.keptZat + t.refundedZat) problems.push(`received ${zat(t.receivedZat)} is not kept ${zat(t.keptZat)} plus refunded ${zat(t.refundedZat)}`);
    if (!sealedBasic && t.keptZat !== keptByRule) problems.push(`kept is ${zat(t.keptZat)} but the winners pay ${zat(keptByRule)} in all`);
    if (t.refundedZat !== listedRefunds) problems.push(`refunded is ${zat(t.refundedZat)} but the listed refunds add up to ${zat(listedRefunds)}`);
    const lateListed = r.refunds.filter((f) => f.reason === "late").length;
    if (t.payments < r.bids.length + lateListed) problems.push(`${t.payments} payments is fewer than the ${r.bids.length} bids plus ${lateListed} late payments the seller lists`);
    add({
      id: "published-totals",
      level: 1,
      title: "Published totals add up",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length
        ? `The published totals do not add up: ${problems.join("; ")}.`
        : `Received ${zat(t.receivedZat)} = kept ${zat(t.keptZat)} + refunded ${zat(t.refundedZat)}, and the kept and refunded figures match the winners and the listed refunds.`,
      fromSeller: [`${t.payments} payments`, `received ${zat(t.receivedZat)}`, `kept ${zat(t.keptZat)}`, `refunded ${zat(t.refundedZat)}`],
    });
  }

  const basicLevel: Status = checks.every((c) => c.status === "PASS") ? "PASS" : "FAIL";

  // ---------------- Key level: read the lot's payments with the lot key ----------------
  let keyLevel: Status | "not run" = "not run";
  let keyLevelNote = "";
  let fingerprint: string | null = null;
  let sealedSummary: SealedSummary | undefined;
  if (opts.basicOnly) {
    keyLevelNote = "Basic level only was asked for. The key level was not run.";
  } else if (d.ufvk === undefined || d.ufvk === null || d.ufvk === "") {
    keyLevelNote = "The disclosure has no lot key, so only the basic level ran.";
  } else {
    const key = assertViewingKey(d.ufvk, d.network);
    fingerprint = keyFingerprint(key);
    sealedSummary = keyChecks(d, r, key, add, zat, memo, short);
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
    ...(sealedSummary ? { sealed: sealedSummary } : {}),
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
): SealedSummary | undefined {
  const goalRules = d.rules.kind === "goal" ? d.rules : null;
  const sealedRules = d.rules.kind === "sealed" ? d.rules : null;
  const ar = d.rules as AuctionRules; // only read when goalRules is null
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
  const sealPrefix = sealMemoPrefix(d.lotId);
  const openPrefix = openMemoPrefix(d.lotId);
  const bids = new Map<string, ChainBid>();
  // Sealed lots: the seal and opening payments, one entry per transaction (outputs summed).
  const sealTxs = new Map<string, ChainBid>();
  const openTxs = new Map<string, ChainBid>();
  const outside: { txid: string; amountZat: number; memo: string }[] = [];
  const refunds: { txid: string; bidTxid: string; amountZat: number; pool: ReadOutput["pool"]; recipientHex: string }[] = [];
  for (const x of read) {
    for (const o of x.outputs) {
      if (o.transferType === "incoming") {
        if (sealedRules && (o.memo.startsWith(sealPrefix) || o.memo.startsWith(openPrefix))) {
          const into = o.memo.startsWith(sealPrefix) ? sealTxs : openTxs;
          const prev = into.get(x.txid);
          if (prev) {
            prev.amountZat += o.amountZat;
            prev.outputs += 1;
          } else {
            into.set(x.txid, { txid: x.txid, amountZat: o.amountZat, height: x.height, memo: o.memo, outputs: 1 });
          }
        } else if (!sealedRules && o.memo.startsWith(bidPrefix)) {
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
        refunds.push({ txid: x.txid, bidTxid: o.memo.slice(refPrefix.length), amountZat: o.amountZat, pool: o.pool, recipientHex: o.recipientHex });
      }
      // "internal" outputs are the lot's own change and are not counted.
    }
  }
  // A bid memo used again in a later transaction is a replay: it is not a new bid. It is
  // reported by the duplicate check and, like a late bid, owed back in full.
  // With top-ups on, a repeated memo before the close raises the bid instead of replaying it.
  const topUps = !goalRules && !sealedRules && ar.topUps === true;
  const grouped = groupBidPayments([...bids.values()].sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : 1)), topUps, d.closeHeight);
  const replays: ChainBid[] = grouped.replays;
  const topUpPayments = topUps ? [...bids.values()].filter((b) => b.height <= d.closeHeight).length - grouped.bids.filter((b) => b.height <= d.closeHeight).length : 0;
  let allBids = grouped.bids;
  const mergedAmount = new Map(grouped.bids.map((b) => [b.txid, b.amountZat]));
  let onTime = allBids.filter((b) => b.height <= d.closeHeight);
  let late = allBids.filter((b) => b.height > d.closeHeight);
  let lateIds = new Set(late.map((b) => b.txid));
  // Sealed lots: work out which seals count. skipIds are seals the bid-count check leaves to the
  // sealed checks, the way it leaves late bids to the late-bid check.
  let sealedOut: ReturnType<typeof openSeals> | null = null;
  let skipIds = lateIds;
  let sealedAmount: (txid: string) => number | undefined = (txid) => (topUps ? mergedAmount.get(txid) : bids.get(txid)?.amountZat);
  if (sealedRules) {
    const sealFacts: SealFact[] = [...sealTxs.values()].map((t) => {
      const m = parseSealMemo(d.lotId, t.memo);
      return { txid: t.txid, height: t.height, paidZat: t.amountZat, valid: !!m && t.outputs === 1, word: m?.word ?? "", hash: m?.hash ?? "", address: m?.address ?? null };
    });
    const openFacts: OpenFact[] = [...openTxs.values()].map((t) => {
      const m = parseOpenMemo(d.lotId, t.memo);
      return { txid: t.txid, height: t.height, paidZat: t.amountZat, valid: !!m && t.outputs === 1, word: m?.word ?? "", amountZat: m?.amountZat ?? 0, salt: m?.salt ?? "" };
    });
    const so = openSeals(d.lotId, sealedRules, d.closeHeight, d.openByHeight as number, sealFacts, openFacts);
    sealedOut = so;
    for (const [id, t] of sealTxs) bids.set(id, t);
    const asBid = (s: { txid: string }) => sealTxs.get(s.txid)!;
    const counted = new Set(so.counted.map((b) => b.txid));
    allBids = so.counted.map((b) => ({ ...asBid(b), amountZat: b.amountZat }));
    onTime = allBids;
    late = so.lateSeals.map(asBid);
    lateIds = new Set(late.map((b) => b.txid));
    skipIds = new Set([...sealTxs.keys()].filter((id) => !counted.has(id)));
    const opened = new Map<string, number>();
    for (const s of [...so.badOpen, ...so.counted]) {
      const o = so.openingOf.get(s.txid);
      if (o) opened.set(s.txid, o.amountZat);
    }
    sealedAmount = (txid) => opened.get(txid);
  }

  add({
    id: "key-hygiene",
    level: 2,
    title: "Lot key shows only this lot's payments",
    status: outside.length ? "FAIL" : "PASS",
    reason: outside.length
      ? `The key shows ${outside.length} payment(s) into this address that are not ${sealedRules ? "seals or openings" : "bids"} for ${d.lotId}. Publishing this key exposes them. Use a fresh one-time key for every lot.`
      : `Every incoming payment the key shows is a ${sealedRules ? "seal or an opening" : "bid"} for ${d.lotId}.`,
    fromChain: outside.map((o) => `outside payment ${short(o.txid)}: ${zat(o.amountZat)}, memo ${memo(o.memo)}`),
  });

  // Bid count: the seller's listed bids (leaving out late bids, which the late-bid check judges)
  // must be exactly the on-time bids the key shows.
  const sellerIds = r.bids.map((b) => b.txid).filter((t) => !skipIds.has(t));
  const onTimeIds = new Set(onTime.map((b) => b.txid));
  const notOnChain = sellerIds.filter((t) => !onTimeIds.has(t));
  const sellerIdSet = new Set(sellerIds);
  const notListed = [...onTimeIds].filter((t) => !sellerIdSet.has(t));
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
    const chainAmount = sealedAmount(b.txid);
    if (chainAmount !== undefined && chainAmount !== b.amountZat) wrongAmounts.push(`${short(b.txid)}: seller says ${zat(b.amountZat)}, chain shows ${zat(chainAmount)}`);
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
  let dupMemos = topUps ? [] : [...memoCount.values()].filter((ids) => ids.length > 1);
  let multi = (topUps ? [...bids.values()] : allBids).filter((b) => b.outputs > 1);
  if (sealedOut) {
    // A word sealed twice, or opened twice, is a replay. A transaction holding several seals or openings is also reported.
    dupMemos = [...sealedOut.replayedSeals.map((s) => [s.txid]), ...sealedOut.replayedOpenings.map((o) => [o.txid])];
    multi = [...sealTxs.values(), ...openTxs.values()].filter((b) => b.outputs > 1);
  }
  const dupOk = dupMemos.length === 0 && multi.length === 0;
  add({
    id: "no-duplicate-bids",
    level: 2,
    title: "No duplicate or replayed bid",
    status: dupOk ? "PASS" : "FAIL",
    reason: dupOk
      ? sealedOut
        ? "Every seal word and every opening word is used once, and every transaction holds one seal or one opening."
        : topUps
          ? `Top-ups are allowed in this lot: ${topUpPayments} extra payment(s) under an existing bid memo were added to that bid, and every bid transaction holds one payment.`
          : "Every bid memo is used once and every bid transaction holds one bid."
      : [
          ...(sealedOut
            ? [
                ...sealedOut.replayedSeals.map((s) => `Seal ${short(s.txid)} repeats a word that was already sealed, a replayed seal.`),
                ...sealedOut.replayedOpenings.map((o) => `Opening ${short(o.txid)} repeats a word that was already opened, a replayed opening.`),
              ]
            : dupMemos.map((ids) => `The same bid memo appears in ${ids.length} transactions (${ids.map(short).join(", ")}), a replayed bid.`)),
          ...multi.map((b) => `Transaction ${short(b.txid)} holds ${b.outputs} bids.`),
        ].join(" "),
    fromChain: sealedOut
      ? [`${sealTxs.size} seal payments, ${openTxs.size} opening payments`, `${sealedOut.replayedSeals.length + sealedOut.replayedOpenings.length} replayed`]
      : [`${allBids.length + replays.length} bid payments`, `${replays.length} replayed`],
  });

  const outcome = sealedOut ? sealedOut.outcome : decide(onTime, d.rules);
  const sellerWinnerSet = new Set(r.winners);
  const sameWinners =
    outcome.winners.length === r.winners.length && outcome.winners.every((w) => sellerWinnerSet.has(w));
  const samePrice = outcome.clearingPriceZat === r.clearingPriceZat;
  add({
    id: "winners-and-price",
    level: 2,
    title: goalRules ? "Counted payments recomputed from the chain" : "Winners and clearing price recomputed from the chain",
    status: sameWinners && samePrice ? "PASS" : "FAIL",
    reason: goalRules
      ? sameWinners && samePrice
        ? `Recomputed from the on-time payments: ${outcome.winners.length ? `all ${outcome.winners.length} count towards the goal` : "none count, the goal was missed"}. Same as the seller.`
        : `From the on-time payments, the counted payments should be ${outcome.winners.map(short).join(", ") || "none"}; the seller says ${r.winners.map(short).join(", ") || "none"}.`
      : sameWinners && samePrice
        ? `Recomputed from the on-time bids: winners ${outcome.winners.map(short).join(", ") || "none"}, clearing price ${zat(outcome.clearingPriceZat)}. Same as the seller.`
        : [
            !sameWinners ? `Winners should be ${outcome.winners.map(short).join(", ") || "none"}, the seller says ${r.winners.map(short).join(", ") || "none"}.` : "",
            !samePrice ? `Clearing price should be ${zat(outcome.clearingPriceZat)}, the seller says ${zat(r.clearingPriceZat)}.` : "",
          ].filter(Boolean).join(" "),
    fromChain: goalRules ? [`counted ${outcome.winners.map(short).join(", ") || "none"}`] : [`winners ${outcome.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(outcome.clearingPriceZat)}`],
    fromSeller: goalRules ? [`counted ${r.winners.map(short).join(", ") || "none"}`] : [`winners ${r.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(r.clearingPriceZat)}`],
    fromDisclosure: [goalRules ? `goal ${zat(goalRules.goalZat)}` : `${ar.itemCount} items, reserve ${zat(ar.reserveZat)}`],
  });

  add({
    id: "reserve",
    level: 2,
    title: goalRules ? "Goal outcome from the chain" : "Reserve outcome",
    status: outcome.reserveMet === r.reserveMet ? "PASS" : "FAIL",
    reason: goalRules
      ? outcome.reserveMet === r.reserveMet
        ? `The on-time payments ${outcome.reserveMet ? "reach" : "fall short of"} the goal, as the seller says.`
        : `The seller says the goal was ${r.reserveMet ? "" : "not "}reached, but the on-time payments on the chain ${outcome.reserveMet ? "reach" : "fall short of"} it.`
      : outcome.reserveMet === r.reserveMet
        ? `The reserve was ${outcome.reserveMet ? "" : "not "}met, as the seller says.`
        : `The seller says the reserve was ${r.reserveMet ? "" : "not "}met, the chain says it was ${outcome.reserveMet ? "" : "not "}met.`,
    fromChain: [goalRules ? `goal reached: ${outcome.reserveMet}` : `reserve met: ${outcome.reserveMet}`],
    fromSeller: [goalRules ? `goal reached: ${r.reserveMet}` : `reserve met: ${r.reserveMet}`],
  });

  // Refunds owed, all worked out from the chain: on-time bids by the rule, late bids in full.
  const owed = sealedOut ? new Map(sealedOut.owed) : new Map(outcome.refundsOwed);
  if (!sealedOut) for (const b of [...late, ...replays]) owed.set(b.txid, b.amountZat);
  const paid = new Map<string, number>();
  for (const f of refunds) paid.set(f.bidTxid, (paid.get(f.bidTxid) ?? 0) + f.amountZat);
  const refundProblems: string[] = [];
  for (const [txid, amount] of owed) {
    if (amount === 0) continue;
    const got = paid.get(txid);
    if (got === undefined) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but no refund was found`);
    else if (got !== amount) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but was refunded ${zat(got)}`);
  }
  // A refund the chain shows for a bid that is owed nothing, or that the lot key never saw, is
  // money leaving the lot with no bid behind it.
  for (const [txid, got] of paid) {
    if (!(owed.get(txid) ?? 0)) refundProblems.push(`${zat(got)} was paid out as a refund for ${short(txid)}, but no bid the lot key sees is owed anything under that id`);
  }
  const owedCount = [...owed.values()].filter((a) => a > 0).length;
  add({
    id: "refunds-paid",
    level: 2,
    title: "Every refund paid in the exact amount",
    status: refundProblems.length ? "FAIL" : "PASS",
    reason: refundProblems.length
      ? `${refundProblems.length} refund problem(s): ${refundProblems.join("; ")}.`
      : sealedOut
        ? `All ${owedCount} refunds owed (deposits back, winners less the clearing price, penalties taken from seals not opened and shared to the bidders who opened, stray payments in full) were paid exactly, each with a memo naming its payment.`
        : `All ${owedCount} refunds owed (losers in full, winners their bid minus the clearing price, late bids in full) were paid exactly, each with a memo naming its bid.`,
    fromChain: [
      ...[...owed].filter(([, a]) => a > 0).map(([t, a]) => `owed to ${short(t)}: ${zat(a)}`),
      ...refunds.map((f) => `refund for ${short(f.bidTxid)}: ${zat(f.amountZat)}`),
    ],
  });

  // Refund receivers: runs when bidders put a refund address in their bid memo (read from the
  // chain, the seller cannot choose it) or when the disclosure lists one for each bid.
  const memoAddr = new Map<string, string>();
  for (const b of bids.values()) {
    const a = sealedRules ? (parseSealMemo(d.lotId, b.memo)?.address ?? null) : bidMemoAddress(d.lotId, b.memo);
    if (a) memoAddr.set(b.txid, a);
  }
  if (d.refundAddresses !== undefined || memoAddr.size > 0) {
    const problems: string[] = [];
    const listedAddr = new Map<string, string>();
    for (const a of d.refundAddresses ?? []) {
      const k = a.bidTxid.toLowerCase();
      if (listedAddr.has(k)) problems.push(`two refund addresses are listed for bid ${short(k)}`);
      listedAddr.set(k, a.address.trim());
    }
    // The bid memo is the bidder's own word and wins. A seller list that disagrees with it is a fail.
    for (const [txid, addr] of memoAddr) {
      const listed = listedAddr.get(txid);
      if (listed !== undefined && listed !== addr) problems.push(`the seller's list gives a different refund address for bid ${short(txid)} than the one in the bid memo`);
      listedAddr.set(txid, addr);
    }
    const parsed = new Map<string, ParsedAddress>();
    for (const [txid, addr] of listedAddr) {
      if (!bids.has(txid)) {
        problems.push(`a refund address is listed for ${short(txid)}, which is not a bid the lot key sees`);
        continue;
      }
      try {
        const p = parseAddress(addr);
        if (p.network !== d.network) problems.push(`the address given for bid ${short(txid)} is for the ${p.network} network, the lot is on ${d.network}`);
        else parsed.set(txid, p);
      } catch (e) {
        problems.push(`the address given for bid ${short(txid)} is not a usable shielded address (${String((e as Error)?.message ?? e).slice(0, 80)})`);
      }
    }
    let checked = 0;
    for (const [txid, amount] of owed) {
      if (amount === 0) continue;
      if (sealedRules && !bids.has(txid)) continue; // a stray opening payment: nothing was sealed under it
      if (!listedAddr.has(txid)) {
        problems.push(`no refund address is given for bid ${short(txid)} (not in its bid memo and not in the seller's list)`);
        continue;
      }
      const p = parsed.get(txid);
      if (!p) continue; // already reported
      for (const f of refunds.filter((f) => f.bidTxid === txid)) {
        checked++;
        const want = f.pool === "sapling" ? p.sapling : p.orchard;
        if (want === null) problems.push(`the refund for bid ${short(txid)} was paid into the ${f.pool} pool but the address given has no ${f.pool === "sapling" ? "Sapling" : "Orchard"} receiver`);
        else if (want !== f.recipientHex) problems.push(`the refund for bid ${short(txid)} (${zat(f.amountZat)}, transaction ${short(f.txid)}) went to a different address than the one given for that bid`);
      }
    }
    add({
      id: "refund-receivers",
      level: 2,
      title: "Each refund went to the address given for its bid",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length
        ? `${problems.join("; ").replace(/^./, (c) => c.toUpperCase())}.`
        : `All ${checked} refund payments went to the address given for their bid. The lot key recovered the receiver of each one. ${memoAddr.size > 0 ? `${memoAddr.size} of the addresses were written by the bidders in their own bid memos, so the seller could not choose them.` : "The list itself is the seller's word: each bidder should confirm that the address next to their bid is theirs."}`,
      fromChain: [`${refunds.length} refund payments, receiver recovered with the lot key`, `${memoAddr.size} refund addresses read from bid memos`],
      fromDisclosure: [`${d.refundAddresses?.length ?? 0} refund addresses listed`],
    });
  }

  // Refund total: the seller's books must balance against what the chain shows came in.
  // Rule: refunds the seller lists (for bids the key can see) + clearing price x winners
  //       = total bid payments received - fee allowance. The fee allowance is 0: network fees
  //       are paid by the seller on top, never out of bidders' money.
  const received = sealedRules
    ? [...sealTxs.values(), ...openTxs.values()].reduce((s, b) => s + b.amountZat, 0)
    : [...allBids, ...replays].reduce((s, b) => s + b.amountZat, 0);
  const sellerRefunds = r.refunds.filter((f) => bids.has(f.bidTxid) || openTxs.has(f.bidTxid)).reduce((s, f) => s + f.amountZat, 0);
  const kept = goalRules
    ? r.winners.reduce((s, w) => s + (bids.get(w)?.amountZat ?? 0), 0)
    : r.clearingPriceZat * r.winners.length;
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

  if (r.totals) {
    const t = r.totals;
    const chainPayments = sealedRules ? sealTxs.size : bids.size;
    const chainRefunded = refunds.reduce((s, f) => s + f.amountZat, 0);
    const problems: string[] = [];
    if (t.payments !== chainPayments) problems.push(`the totals say ${t.payments} payments, the key shows ${chainPayments}`);
    if (t.receivedZat !== received) problems.push(`the totals say ${zat(t.receivedZat)} was received, the key shows ${zat(received)}`);
    if (t.refundedZat !== chainRefunded) problems.push(`the totals say ${zat(t.refundedZat)} was refunded, the chain shows ${zat(chainRefunded)}`);
    if (t.keptZat !== received - chainRefunded) problems.push(`the totals say the seller keeps ${zat(t.keptZat)}, the chain shows ${zat(received - chainRefunded)} kept`);
    add({
      id: "published-totals-chain",
      level: 2,
      title: "Published totals match the chain",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length
        ? `The published totals differ from the chain: ${problems.join("; ")}.`
        : `${chainPayments} payments, ${zat(received)} received, ${zat(chainRefunded)} refunded and ${zat(received - chainRefunded)} kept, exactly as published.`,
      fromChain: [`${chainPayments} payments`, `received ${zat(received)}`, `refunded ${zat(chainRefunded)}`, `kept ${zat(received - chainRefunded)}`],
      fromSeller: [`${t.payments} payments`, `received ${zat(t.receivedZat)}`, `refunded ${zat(t.refundedZat)}`, `kept ${zat(t.keptZat)}`],
    });
  }

  if (sealedRules && sealedOut) {
    const so = sealedOut;
    const listedIds = new Set(r.bids.map((b) => b.txid));

    // Seal deposits: a seal that paid the wrong amount, paid late, repeated a word or has a broken memo is
    // never a bid. It is refunded in full. The seller must not count it.
    const notBids = [
      ...so.badDeposit.map((x) => ({ txid: x.txid, why: x.valid ? `paid ${zat(x.paidZat)} instead of the deposit ${zat(sealedRules.depositZat)}` : "its memo is not a well-formed seal" })),
      ...so.lateSeals.map((x) => ({ txid: x.txid, why: `arrived at block ${x.height}, after the close at block ${d.closeHeight}` })),
      ...so.replayedSeals.map((x) => ({ txid: x.txid, why: "repeats a word that was already sealed" })),
    ];
    const countedBad = notBids.filter((x) => listedIds.has(x.txid));
    const onTimeSeals = sealTxs.size - notBids.length;
    add({
      id: "seal-deposits",
      level: 2,
      title: "Every counted seal paid exactly the deposit, on time",
      status: countedBad.length ? "FAIL" : "PASS",
      reason: countedBad.length
        ? `The seller counted ${countedBad.length} seal(s) that cannot count: ${countedBad.map((x) => `${short(x.txid)} ${x.why}`).join("; ")}.`
        : `${onTimeSeals} seals paid exactly the deposit ${zat(sealedRules.depositZat)} by block ${d.closeHeight}. ${notBids.length} other seal payments were not counted (wrong deposit, late, repeated or malformed) and are owed back in full.`,
      fromChain: [`${onTimeSeals} seals with the right deposit, on time`, ...notBids.map((x) => `not a bid ${short(x.txid)}: ${x.why}`)],
      fromDisclosure: [`deposit ${zat(sealedRules.depositZat)}`, `close height ${d.closeHeight}`],
    });

    // Seal openings: a seal counts only with one on-time opening whose price matches its seal.
    const notOpened = [
      ...so.unopened.map((x) => ({ txid: x.txid, why: "was never opened in the window" })),
      ...so.badOpen.map((x) => ({ txid: x.txid, why: "was opened with a price that does not match its seal, or above the deposit" })),
    ];
    const countedWrong = notOpened.filter((x) => listedIds.has(x.txid));
    add({
      id: "seal-openings",
      level: 2,
      title: "Every counted bid has one matching opening",
      status: countedWrong.length ? "FAIL" : "PASS",
      reason: countedWrong.length
        ? `The seller counted ${countedWrong.length} seal(s) without a matching opening: ${countedWrong.map((x) => `${short(x.txid)} ${x.why}`).join("; ")}.`
        : `Each of the ${so.counted.length} counted bids has exactly one opening after block ${d.closeHeight} and up to block ${d.openByHeight} whose price matches its seal.`,
      fromChain: [`${so.counted.length} seals with a matching opening`, ...notOpened.map((x) => `not counted ${short(x.txid)}: ${x.why}`)],
      fromSeller: [`${r.bids.length} bids listed`],
      fromDisclosure: [`openings after block ${d.closeHeight}, up to block ${d.openByHeight}`],
    });

    // Seal forfeits: the seller must report every seal that paid the penalty.
    const chainUnopened = [...so.unopened, ...so.badOpen].map((x) => x.txid);
    const said = new Set(r.unopened ?? []);
    const hidden = chainUnopened.filter((t) => !said.has(t));
    const invented = [...said].filter((t) => !chainUnopened.includes(t));
    const forfeitOk = hidden.length === 0 && invented.length === 0;
    const neverOpened = `${so.unopened.length} seals were never opened and ${so.badOpen.length} were opened with a price that does not match`;
    add({
      id: "seal-forfeits",
      level: 2,
      title: "Seals that paid the penalty are all reported",
      status: forfeitOk ? "PASS" : "FAIL",
      reason: forfeitOk
        ? `${neverOpened}. The seller reports the same ${chainUnopened.length}. ${so.penaltyTotal > 0 ? `Their penalties of ${zat(so.penaltyTotal)} were shared to the ${so.counted.length} counted bids.` : "No penalty was charged."}`
        : `${neverOpened}. ${hidden.length ? `Not reported by the seller: ${hidden.map(short).join(", ")}. ` : ""}${invented.length ? `Reported but not unopened on the chain: ${invented.map(short).join(", ")}.` : ""}`.trim(),
      fromChain: [`${so.unopened.length} seals never opened`, `${so.badOpen.length} badly opened`, `penalties ${zat(so.penaltyTotal)}`],
      fromSeller: [`${said.size} unopened seals reported`],
      fromDisclosure: [`penalty per seal ${zat(sealedRules.forfeitZat)}`],
    });
    return { seals: so.counted.length + so.unopened.length + so.badOpen.length, counted: so.counted.length, unopened: so.unopened.length, badlyOpened: so.badOpen.length };
  }
  return undefined;
}
