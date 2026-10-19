// The page's checking logic, with no screen code. It calls the same checkLot as the command
// line tool and returns the same verdict. It never touches the network.
import { assertViewingKey, checkLot, InputError, KeyRefusedError, type Verdict } from "../check.ts";
import { blocksInRange, ScanInputError, validateChainFile, type BlockSource } from "../scan/chain.ts";
import { checkExternalRound, detectExternalRound, ExternalRoundInputError, type ExternalRoundReport } from "../external/published-round.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange, type BidderKey, type ScanInput } from "../scan/scan.ts";

export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export interface PageInputs {
  disclosure: unknown;
  result: unknown;
  /** A saved chain file. When given, the scan level runs. */
  chain?: unknown;
  /** Name shown as the source of the blocks, for example "chain.json". */
  chainLabel?: string;
  bidderKeys?: unknown;
  discreet?: boolean;
  basic?: boolean;
}

export type PageOutcome =
  | { ok: true; verdict: Verdict }
  | { ok: false; kind: "refused" | "input" | "error"; message: string };

/** Parse the text of a dropped file. Throws InputError with a plain message. */
export function parseJsonText(text: string, what: string): unknown {
  if (text.length > MAX_FILE_BYTES) throw new InputError(`Input error: the ${what} file is too large.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`Input error: the ${what} file is not valid JSON.`);
  }
}

function bidderKeysOf(f: any, network: string): BidderKey[] {
  if (!f || f.format !== "imani-bidder-keys/1" || !Array.isArray(f.keys) || f.keys.length === 0) {
    throw new InputError('Input error: the bidder keys file must have "format": "imani-bidder-keys/1" and a non-empty keys list.');
  }
  return f.keys.map((k: any) => {
    if (!k || typeof k.bidTxid !== "string" || !/^[0-9a-f]{64}$/.test(k.bidTxid)) {
      throw new InputError("Input error: every bidder key needs the bidTxid of that bidder's bid (64 hex characters).");
    }
    return { bidTxid: k.bidTxid, ufvk: assertViewingKey(k.ufvk, network) };
  });
}

function scanInput(d: any, chain: any, label: string, bidderKeys: unknown): ScanInput {
  const range = scanRange(d, DEFAULT_GRACE_BLOCKS);
  validateChainFile(chain);
  if (chain.network !== d.network) {
    throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the disclosure says ${d.network}.`);
  }
  const started = Date.now();
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  let bytes = 0;
  for (const b of blocks) for (const t of b.txs) bytes += t.txHex.length / 2;
  const source: BlockSource = {
    kind: "chain-file",
    label: `the chain file ${label} (offline)`,
    serversContacted: [],
    bytes,
    ms: Date.now() - started,
  };
  return {
    blocks,
    missing,
    source,
    graceBlocks: range.graceBlocks,
    bidderKeys: bidderKeys === undefined ? undefined : bidderKeysOf(bidderKeys, d.network),
  };
}

/** Run the checks on files already parsed. Start the reader before this (initReader). */
export function runPage(i: PageInputs): PageOutcome {
  try {
    const d = i.disclosure as any;
    const scan = i.chain !== undefined ? scanInput(d, i.chain, i.chainLabel ?? "chain file", i.bidderKeys) : undefined;
    const verdict = checkLot(d, i.result as any, { basicOnly: !!i.basic, discreet: !!i.discreet, scan });
    return { ok: true, verdict };
  } catch (e) {
    if (e instanceof KeyRefusedError) return { ok: false, kind: "refused", message: e.message };
    if (e instanceof InputError || e instanceof ScanInputError) return { ok: false, kind: "input", message: e.message };
    // A fixed message, so nothing from the input can leak into the output.
    return { ok: false, kind: "error", message: "Unexpected error while checking. Nothing was kept." };
  }
}

export type ExternalOutcome = { ok: true; report: ExternalRoundReport } | { ok: false; message: string };

/** Read a round another auction project published. Uses only the numbers in the file; no network. */
export function runExternalPage(parsed: unknown): ExternalOutcome {
  try {
    return { ok: true, report: checkExternalRound(parsed) };
  } catch (e) {
    if (e instanceof ExternalRoundInputError) return { ok: false, message: e.message };
    return { ok: false, message: "This file could not be read as a published round. Nothing was kept." };
  }
}

/** Decide which kind of file this is, from its "format" field. */
export function fileKind(parsed: any): "disclosure" | "result" | "chain" | "bidderKeys" | "external" | null {
  if (detectExternalRound(parsed)) return "external";
  switch (parsed?.format) {
    case "imani-lot-disclosure/1": return "disclosure";
    case "imani-lot-result/1": return "result";
    case "imani-chain/1": return "chain";
    case "imani-bidder-keys/1": return "bidderKeys";
    default: return null;
  }
}

export { initReader, decoderBytes, decoderInfo } from "./reader.ts";
export { lookupBid } from "../mine.ts";
export { serversLine, scanSourceLine } from "../report.ts";
export type { Verdict };
