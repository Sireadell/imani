// Bid proof: one bid, proven to someone who holds no viewing key. See docs/BID_PROOF.md.
//
// Each shielded Orchard or Ironwood payment is encrypted with its own one-time secret, here
// called the payment's opening key (32 bytes). It opens that one payment and nothing else.
// The lot owner can work it out for every bid with the lot key; a bidder whose wallet kept a
// sender copy can work it out for their own bid. The proof file carries the opening key, the
// bid's raw transaction and the facts it claims. A checker opens the payment with
// librustzcash, which only succeeds when the amount, memo and receiver match the commitments
// fixed in the transaction, then ties the payment to its block and to the seller's result.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { InputError } from "./check.ts";
import { bidMemoAddress, bidMemoPrefix } from "./files.ts";
import { checkTxBytes, TXID_RE } from "./fetch/verify.ts";
import { parseAddress } from "./read.ts";

// Prebuilt WebAssembly (librustzcash). Source and rebuild steps: tools/disclose/.
const require = createRequire(import.meta.url);
const disclosure = require("../vendor/disclose/imani_disclose.js") as {
  discloseOutputs(txHex: string, ufvk: string): { txid: string; outputs: DisclosedOutput[] };
  openOutput(txHex: string, pool: string, index: number, receiverHex: string, eskHex: string): OpenedOutput;
  orchardAddress(receiverHex: string, network: string): string;
};

export const BID_PROOF_FORMAT = "imani-bid-proof/1";

/** One payment a viewing key can see, with the key that opens that payment alone. */
export interface DisclosedOutput {
  pool: "orchard" | "ironwood";
  index: number;
  transferType: "incoming" | "outgoing" | "internal";
  amountZat: number;
  memo: string;
  memoHex: string;
  recipientHex: string;
  /** The payment's opening key: 32 bytes as hex. Opens this payment and no other. */
  eskHex: string;
}

/** What opening one payment shows. */
export interface OpenedOutput {
  txid: string;
  pool: "orchard" | "ironwood";
  index: number;
  /** How many actions of that pool the transaction has. */
  actions: number;
  amountZat: number;
  memo: string;
  memoHex: string;
  recipientHex: string;
}

/** The bid proof file, `imani-bid-proof/1`. Holds no viewing key. */
export interface BidProof {
  format: typeof BID_PROOF_FORMAT;
  lot: {
    lotId: string;
    network: "main" | "test";
    /** Where the bid was paid. Its Orchard receiver is what the opening key is checked against. */
    lotAddress: string;
    openHeight?: number;
    closeHeight: number;
  };
  bid: {
    txid: string;
    /** The block the bid was mined in, as the maker read it. A checker confirms it from the chain. */
    height: number;
    pool: "orchard" | "ironwood";
    /** Position of the payment among that pool's actions in the transaction. */
    index: number;
    amountZat: number;
    memo: string;
    word: string;
  };
  /** The payment's opening key, 64 hex characters. */
  openingKey: string;
  /** The bid transaction, as hex. Its id must equal bid.txid. */
  txHex: string;
  /** Optional: the SHA-256 of the seller's published result file the maker read. */
  result?: { sha256: string };
}

export class BidProofError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;
const LOT_ID = /^[A-Za-z0-9._-]{1,40}$/;
const isWhole = (n: unknown, min: number) => Number.isSafeInteger(n) && (n as number) >= min;

/** The bidder's word: the part of `bid:<lotId>:<word>[:<refund address>]` after the lot id. */
export function bidWord(lotId: string, memo: string): string | null {
  const prefix = bidMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const rest = memo.slice(prefix.length);
  const word = bidMemoAddress(lotId, memo) === null ? rest : rest.slice(0, rest.lastIndexOf(":"));
  return word === "" ? null : word;
}

/** The SHA-256 of a file's bytes, as hex. Used to name the published result a proof was made against. */
export const sha256Hex = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Orchard receiver (43 bytes, hex) of a payment address, or null. Ironwood payments use the same receiver. */
function orchardReceiver(address: string): string | null {
  try {
    return parseAddress(address).orchard;
  } catch {
    return null;
  }
}

/**
 * Throws InputError unless the file is a well-formed `imani-bid-proof/1`. Any field the format
 * does not define is refused, so a proof can never carry a viewing key by accident.
 */
export function validateBidProof(p: any): asserts p is BidProof {
  const bad = (m: string): never => {
    throw new InputError(`Input error: the bid proof ${m}`);
  };
  const only = (o: any, keys: string[], where: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`has a field the format does not define: ${where}${k}. Nothing else may be added, so no key can travel in it.`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("is not a JSON object.");
  if (p.format !== BID_PROOF_FORMAT) bad(`must have "format": "${BID_PROOF_FORMAT}".`);
  only(p, ["format", "lot", "bid", "openingKey", "txHex", "result"], "");
  const l = p.lot;
  if (!l || typeof l !== "object") bad("needs a lot object.");
  only(l, ["lotId", "network", "lotAddress", "openHeight", "closeHeight"], "lot.");
  if (typeof l.lotId !== "string" || !LOT_ID.test(l.lotId)) bad("needs a lot.lotId of 1 to 40 letters, digits, dots, dashes or underscores.");
  if (l.network !== "main" && l.network !== "test") bad('needs lot.network "main" or "test".');
  if (typeof l.lotAddress !== "string") bad("needs lot.lotAddress.");
  const rec = (() => {
    try {
      return parseAddress(l.lotAddress);
    } catch {
      return null;
    }
  })();
  if (!rec || !rec.orchard) bad("has a lot.lotAddress with no Orchard receiver. Version 1 proves Orchard and Ironwood payments only.");
  if (rec!.network !== l.network) bad(`has a lot.lotAddress for the ${rec!.network} network, but lot.network is ${l.network}.`);
  if (!isWhole(l.closeHeight, 1)) bad("needs a whole number lot.closeHeight.");
  if (l.openHeight !== undefined && (!isWhole(l.openHeight, 1) || l.openHeight > l.closeHeight)) bad("has a lot.openHeight that is not a whole number at or before the close.");
  const b = p.bid;
  if (!b || typeof b !== "object") bad("needs a bid object.");
  only(b, ["txid", "height", "pool", "index", "amountZat", "memo", "word"], "bid.");
  if (typeof b.txid !== "string" || !TXID_RE.test(b.txid)) bad("needs a bid.txid of 64 lowercase hex characters.");
  if (!isWhole(b.height, 1)) bad("needs a whole number bid.height.");
  if (b.pool !== "orchard" && b.pool !== "ironwood") bad('needs bid.pool "orchard" or "ironwood".');
  if (!isWhole(b.index, 0)) bad("needs a whole number bid.index.");
  if (!isWhole(b.amountZat, 1)) bad("needs a whole number bid.amountZat above 0.");
  if (typeof b.memo !== "string" || b.memo.length > 512) bad("needs a bid.memo of at most 512 characters.");
  if (typeof b.word !== "string" || b.word === "") bad("needs a bid.word.");
  if (typeof p.openingKey !== "string" || !HEX64.test(p.openingKey)) bad("needs an openingKey of 64 lowercase hex characters.");
  if (typeof p.txHex !== "string" || p.txHex.length < 24 || p.txHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(p.txHex)) bad("needs txHex: the bid transaction as lowercase hex.");
  if (p.result !== undefined) {
    if (!p.result || typeof p.result !== "object") bad("has a result field that is not an object.");
    only(p.result, ["sha256"], "result.");
    if (typeof p.result.sha256 !== "string" || !HEX64.test(p.result.sha256)) bad("needs result.sha256 of 64 lowercase hex characters.");
  }
}

/** The lot facts a proof is made for: the published `imani-lot-public/1` fields it uses. */
export interface ProofLotFacts {
  lotId: string;
  network: "main" | "test";
  lotAddress?: string;
  openHeight?: number;
  closeHeight: number;
}

export interface MakeBidProofInput {
  facts: ProofLotFacts;
  /** The lot's viewing key (the lot owner issues the proof), or the bidder's own (if their wallet kept a sender copy). It is used here and never written. */
  viewingKey: string;
  txid: string;
  txHex: string;
  /** The block the bid was mined in. */
  height: number;
  /** Optional: the bytes of the seller's published result file, so the proof records which file it was made against. */
  resultFile?: string | Uint8Array;
}

/**
 * Make a bid proof for one bid. Opens the transaction with the viewing key, finds the one
 * payment to the lot with a bid memo of this lot, and writes down that payment's opening key.
 * Throws BidProofError when the key cannot see such a payment.
 */
export function makeBidProof(inp: MakeBidProofInput): BidProof {
  const f = inp.facts;
  const txid = inp.txid.toLowerCase();
  if (!TXID_RE.test(txid)) throw new BidProofError("The bid's transaction id must be 64 hex characters.");
  const bytesProblem = checkTxBytes(inp.txHex, txid);
  if (bytesProblem) throw new BidProofError(`The transaction bytes do not match ${txid.slice(0, 10)}: ${bytesProblem}.`);
  let seen: { txid: string; outputs: DisclosedOutput[] };
  try {
    seen = disclosure.discloseOutputs(inp.txHex, inp.viewingKey);
  } catch (e) {
    throw new BidProofError(`The transaction could not be read with this key: ${(e as Error).message}.`);
  }
  const wantReceiver = f.lotAddress ? orchardReceiver(f.lotAddress) : null;
  if (f.lotAddress && !wantReceiver) throw new BidProofError("The lot address in the facts has no Orchard receiver. Version 1 proves Orchard and Ironwood payments only.");
  const prefix = bidMemoPrefix(f.lotId);
  // A bid is a payment into the lot. With the lot key it shows as incoming; with the bidder's key as outgoing.
  const bids = seen.outputs.filter(
    (o) => o.memo.startsWith(prefix) && o.transferType !== "internal" && (wantReceiver === null || o.recipientHex === wantReceiver),
  );
  if (bids.length === 0) {
    throw new BidProofError(
      `This key sees no bid for lot ${f.lotId}${f.lotAddress ? " paid to the lot address" : ""} in transaction ${txid.slice(0, 10)}. Use the lot's viewing key, or the bidder's own key if their wallet kept a copy of what it sent.`,
    );
  }
  if (bids.length > 1) throw new BidProofError(`Transaction ${txid.slice(0, 10)} holds ${bids.length} bid payments. A transaction with more than one bid does not count as a bid (no-duplicate-bids).`);
  const o = bids[0];
  const word = bidWord(f.lotId, o.memo);
  if (!word) throw new BidProofError("The bid memo has no word after the lot id.");
  const lotAddress = f.lotAddress ?? disclosure.orchardAddress(o.recipientHex, f.network);
  const proof: BidProof = {
    format: BID_PROOF_FORMAT,
    lot: { lotId: f.lotId, network: f.network, lotAddress, ...(f.openHeight !== undefined ? { openHeight: f.openHeight } : {}), closeHeight: f.closeHeight },
    bid: { txid, height: inp.height, pool: o.pool, index: o.index, amountZat: o.amountZat, memo: o.memo, word },
    openingKey: o.eskHex,
    txHex: inp.txHex.toLowerCase(),
    ...(inp.resultFile !== undefined ? { result: { sha256: sha256Hex(inp.resultFile) } } : {}),
  };
  validateBidProof(proof);
  return proof;
}

/** PROVEN: shown from the chain or a file you gave. GIVEN: taken from the proof file's word. NOT CHECKED: nothing to check it against. */
export type ProofMark = "PROVEN" | "GIVEN" | "NOT CHECKED" | "FAIL";
export interface ProofLine {
  id: string;
  mark: ProofMark;
  text: string;
}

export interface BidProofReport {
  result: "PASS" | "FAIL" | "NOT PROVEN";
  lotId: string;
  txid: string;
  lines: ProofLine[];
  /** What the seller's result says about this bid. The seller's word, never part of the verdict. */
  sellerSays: string[];
  /** Ids of the lines marked FAIL. */
  failed: string[];
  serversContacted: string[];
}

/** Where the bid was mined, from a source the checker trusts (a chain file or two servers). */
export interface MinedAt {
  /** Block height, or null when the source holds the transaction but names no block, or does not hold it. */
  height: number | null;
  found: boolean;
  /** Plain words: "the chain file chain.json (offline)" or "testnet.zec.rocks and api.testnet.cipherscan.app". */
  source: string;
  serversContacted: string[];
}

export interface VerifyOptions {
  /** The lot facts the seller published (`imani-lot-public/1`). */
  facts?: ProofLotFacts;
  /** The seller's published result file, parsed. */
  result?: any;
  /** The raw bytes of that result file, to compare with the proof's `result.sha256`. */
  resultBytes?: string | Uint8Array;
  /** Where the bid transaction is on the chain. */
  mined?: MinedAt;
}

const zat = (n: number) => `${n.toLocaleString("en-US")} zat`;

/** What a bid proof shows and what it does not. Printed with every report. */
export const BID_PROOF_LIMITS = [
  "It proves one payment: its amount, its memo and that it was paid to the lot address. It does not show any other payment, bid or refund.",
  "It does not prove who paid. Anyone holding the file can show it.",
  "Counted means the seller's published result lists this bid at this amount. Whether the seller's winners, price and refunds are right needs the full check of the round.",
  "It covers auction and goal lots. Sealed lots (a seal and an opening) are not covered by version 1.",
];

/**
 * Check a bid proof. Needs no viewing key. Every line is PROVEN, GIVEN (taken from the proof
 * file), NOT CHECKED (nothing given to check it against) or FAIL. PASS needs every line PROVEN.
 */
export function verifyBidProof(proof: BidProof, opts: VerifyOptions = {}): BidProofReport {
  validateBidProof(proof);
  const lines: ProofLine[] = [];
  const add = (id: string, mark: ProofMark, text: string) => lines.push({ id, mark, text });
  const { lot, bid } = proof;
  const short = bid.txid.slice(0, 10);

  // 1. The bytes are the transaction they claim to be.
  const bytesProblem = checkTxBytes(proof.txHex, bid.txid);
  if (bytesProblem) add("txid-matches-bytes", "FAIL", `The transaction bytes are not transaction ${short}: ${bytesProblem}.`);
  else add("txid-matches-bytes", "PROVEN", `The transaction id ${short} was recomputed from the bytes in the proof.`);

  // 2. The opening key opens that payment, paid to the lot address.
  const receiver = orchardReceiver(lot.lotAddress)!;
  let opened: OpenedOutput | null = null;
  try {
    opened = disclosure.openOutput(proof.txHex, bid.pool, bid.index, receiver, proof.openingKey);
  } catch (e) {
    add("payment-opens", "FAIL", `The opening key does not open ${bid.pool} payment ${bid.index} of this transaction as a payment to the lot address (${(e as Error).message}).`);
  }
  if (opened) {
    add(
      "payment-opens",
      "PROVEN",
      `The opening key opens ${bid.pool} payment ${bid.index} of ${opened.actions}, paid to the lot address. librustzcash checked the opened amount, memo and receiver against the commitments in the transaction.`,
    );
    // 3. Amount and memo are what the chain holds.
    if (opened.amountZat === bid.amountZat) add("bid-amount", "PROVEN", `The payment is ${zat(opened.amountZat)}, as the proof says.`);
    else add("bid-amount", "FAIL", `The proof says ${zat(bid.amountZat)}, but the payment on the chain is ${zat(opened.amountZat)}.`);
    const word = bidWord(lot.lotId, opened.memo);
    if (opened.memo !== bid.memo) add("bid-memo", "FAIL", `The proof states a different memo from the one in the payment ("${opened.memo.slice(0, 80)}").`);
    else if (word === null) add("bid-memo", "FAIL", `The memo in the payment is not a bid for lot ${lot.lotId}: "${opened.memo.slice(0, 80)}".`);
    else if (word !== bid.word) add("bid-memo", "FAIL", `The memo in the payment carries the word "${word}", not "${bid.word}".`);
    else add("bid-memo", "PROVEN", `The payment's memo is "${opened.memo}": a bid for lot ${lot.lotId} with the word "${word}".`);
  } else {
    add("bid-amount", "FAIL", "The payment could not be opened, so its amount is unknown.");
    add("bid-memo", "FAIL", "The payment could not be opened, so its memo is unknown.");
  }

  // 4. The lot facts in the proof are the seller's published ones.
  const f = opts.facts;
  let factsProven = false;
  if (!f) {
    add("lot-facts", "GIVEN", `The lot address and the close at block ${lot.closeHeight} come from the proof file. Give the seller's published lot facts (--facts) to confirm them.`);
  } else {
    const diffs: string[] = [];
    if (f.lotId !== lot.lotId) diffs.push(`lot id ${f.lotId}, not ${lot.lotId}`);
    if (f.network !== lot.network) diffs.push(`network ${f.network}, not ${lot.network}`);
    if (f.closeHeight !== lot.closeHeight) diffs.push(`close at block ${f.closeHeight}, not ${lot.closeHeight}`);
    if (f.openHeight !== undefined && f.openHeight !== lot.openHeight) diffs.push(`open at block ${f.openHeight}, not ${lot.openHeight ?? "unstated"}`);
    const pubReceiver = f.lotAddress ? orchardReceiver(f.lotAddress) : null;
    if (f.lotAddress && pubReceiver !== receiver) diffs.push("a different lot address");
    if (diffs.length) add("lot-facts", "FAIL", `The published lot facts say ${diffs.join("; ")}.`);
    else if (!f.lotAddress) add("lot-facts", "GIVEN", "The published lot facts match the proof, but they do not name the lot address, so where the payment went rests on the proof file.");
    else {
      factsProven = true;
      add("lot-facts", "PROVEN", "Lot id, network, lot address and close height match the seller's published lot facts.");
    }
  }

  // 5. The bid is on the chain, in the block the proof names.
  const m = opts.mined;
  let heightProven = false;
  if (!m) add("mined-height", "GIVEN", `Block ${bid.height} is the proof file's word, and so is the payment being on the chain at all. Give --chain or --fetch to confirm it.`);
  else if (!m.found) add("mined-height", "FAIL", `Transaction ${short} is not in ${m.source}.`);
  else if (m.height === null) add("mined-height", "GIVEN", `${m.source} hold transaction ${short} but did not say which block mined it, so block ${bid.height} is the proof file's word.`);
  else if (m.height !== bid.height) add("mined-height", "FAIL", `The proof says block ${bid.height}, but ${m.source} put transaction ${short} in block ${m.height}.`);
  else {
    heightProven = true;
    add("mined-height", "PROVEN", `Transaction ${short} is in block ${m.height}, read from ${m.source}.`);
  }

  // 6. On time: inside the bidding window.
  const window = `${lot.openHeight !== undefined ? `${lot.openHeight} to ` : "up to "}${lot.closeHeight}`;
  const outside = bid.height > lot.closeHeight || (lot.openHeight !== undefined && bid.height < lot.openHeight);
  if (outside) add("on-time", "FAIL", `Block ${bid.height} is outside the bidding window (${window}). A late bid must not be counted.`);
  else if (heightProven && factsProven) add("on-time", "PROVEN", `Block ${bid.height} is inside the bidding window (${window}).`);
  else add("on-time", "GIVEN", `Block ${bid.height} is inside the bidding window (${window}), but ${!heightProven ? "the block" : "the window"} is the proof file's word.`);

  // 7. Counted: the seller's published result lists this bid at this amount.
  const sellerSays: string[] = [];
  const r = opts.result;
  if (r === undefined) {
    add("counted", "NOT CHECKED", "Give the seller's published result (--result) to check that it counts this bid.");
  } else {
    if (!r || typeof r !== "object" || !Array.isArray(r.bids)) throw new InputError("Input error: the seller result file needs a bids list.");
    if (r.rules?.kind === "sealed") throw new InputError("Input error: this is a sealed lot. Version 1 of the bid proof covers auction and goal lots only.");
    const entry = r.bids.find((x: any) => String(x?.txid ?? "").toLowerCase() === bid.txid);
    const amount = opened?.amountZat ?? bid.amountZat;
    if (r.lotId !== lot.lotId) add("counted", "FAIL", `The result file is for lot ${String(r.lotId)}, not ${lot.lotId}.`);
    else if (!entry) add("counted", "FAIL", `The seller's published result does not count bid ${short}.`);
    else if (entry.amountZat !== amount && r.rules?.topUps === true) {
      add("counted", "NOT CHECKED", `The seller counts this bid at ${zat(entry.amountZat)} and this payment is ${zat(amount)}. The lot allows top-ups, so other payments under the same memo may add to it, and this proof covers one payment.`);
    } else if (entry.amountZat !== amount) add("counted", "FAIL", `The seller counts this bid at ${zat(entry.amountZat)}, but the payment is ${zat(amount)}.`);
    else add("counted", "PROVEN", `The seller's published result counts bid ${short} at ${zat(entry.amountZat)}.`);
    if (entry) {
      const won = Array.isArray(r.winners) && r.winners.map((w: any) => String(w).toLowerCase()).includes(bid.txid);
      const refunded = Array.isArray(r.refunds) ? r.refunds.filter((x: any) => String(x?.bidTxid ?? "").toLowerCase() === bid.txid).reduce((s: number, x: any) => s + (Number(x.amountZat) || 0), 0) : 0;
      const kind = r.rules?.kind === "goal" ? (won ? "kept (goal reached)" : "not kept") : won ? `won, at a price of ${zat(Number(r.clearingPriceZat) || 0)}` : "did not win";
      sellerSays.push(`The seller's result says this bid ${kind}, with ${zat(refunded)} refunded.`);
    }
    if (proof.result && opts.resultBytes !== undefined) {
      const have = sha256Hex(opts.resultBytes);
      if (have === proof.result.sha256) add("result-file", "PROVEN", "The result file you gave is the same file the proof was made against.");
      else add("result-file", "FAIL", "The result file you gave is not the one the proof was made against (different SHA-256). The seller may have changed it after the proof was made.");
    }
  }

  const failed = lines.filter((l) => l.mark === "FAIL").map((l) => l.id);
  const result: BidProofReport["result"] = failed.length ? "FAIL" : lines.every((l) => l.mark === "PROVEN") ? "PASS" : "NOT PROVEN";
  return { result, lotId: lot.lotId, txid: bid.txid, lines, sellerSays, failed, serversContacted: m?.serversContacted ?? [] };
}

export function bidProofText(r: BidProofReport): string {
  const out: string[] = [`Bid proof for lot ${r.lotId}, bid ${r.txid}. No viewing key was used.`, ""];
  for (const l of r.lines) out.push(`  [${l.mark}] ${l.id}: ${l.text}`);
  if (r.sellerSays.length) out.push("", ...r.sellerSays.map((s) => `  ${s} (The seller's word, not checked here.)`));
  const given = r.lines.filter((l) => l.mark !== "PROVEN" && l.mark !== "FAIL").map((l) => l.id);
  out.push(
    "",
    r.result === "FAIL"
      ? `RESULT: FAIL (${r.failed.length} of ${r.lines.length} lines failed: ${r.failed.join(", ")})`
      : r.result === "PASS"
        ? `RESULT: PASS (${r.lines.length} of ${r.lines.length} lines proven)`
        : `RESULT: NOT PROVEN (nothing wrong found; not proven: ${given.join(", ")})`,
  );
  out.push("", "What a bid proof shows and does not show:");
  for (const l of BID_PROOF_LIMITS) out.push(`  - ${l}`);
  out.push("", `Servers contacted: ${r.serversContacted.length ? r.serversContacted.join(", ") : "none"}`);
  return out.join("\n");
}
