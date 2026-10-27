// The blocks a scan reads, ready to hand to checkLot as `{ scan }`. This is what the command line
// does for --scan --chain and --scan --fetch, as two plain functions for the library.
//
//   const scan = scanFromChain(disclosure, chainFile);          // offline, from a saved block file
//   const scan = await fetchScan(disclosure);                    // live, two servers must agree
//   const verdict = checkLot(disclosure, result, { scan });      // adds the scan checks, such as scan-hidden-bids

import type { Disclosure } from "../files.ts";
import { blocksInRange, ScanInputError, validateChainFile, type BlockSource } from "./chain.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange, type BidderKey, type ScanInput } from "./scan.ts";
import { fetchBlocks, type FetchBlocksOptions } from "./fetch-blocks.ts";

type RangeFacts = Pick<Disclosure, "network" | "openHeight" | "closeHeight" | "refundByHeight">;

export interface ScanFromChainOptions {
  /** Blocks past the close that are always read, so a bid that just missed the close is found. Default 10. */
  graceBlocks?: number;
  /** Bidders' own viewing keys, to prove their refunds reached them. */
  bidderKeys?: BidderKey[];
  /** How the report names the block file. Default "a saved block file (offline)". */
  label?: string;
}

/**
 * Take the lot's blocks out of a saved block file. Opens no connection.
 * Throws ScanInputError if the file is not a valid block file or is for the other network.
 */
export function scanFromChain(d: RangeFacts, chain: unknown, opts: ScanFromChainOptions = {}): ScanInput {
  const range = scanRange(d, opts.graceBlocks ?? DEFAULT_GRACE_BLOCKS);
  validateChainFile(chain);
  if (chain.network !== d.network) throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the disclosure says ${d.network}.`);
  const started = Date.now();
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  let bytes = 0;
  for (const b of blocks) for (const t of b.txs) bytes += t.txHex.length / 2;
  const source: BlockSource = { kind: "chain-file", label: opts.label ?? "a saved block file (offline)", serversContacted: [], bytes, ms: Date.now() - started };
  return { blocks, missing, source, graceBlocks: range.graceBlocks, bidderKeys: opts.bidderKeys };
}

export type FetchScanOptions = Omit<FetchBlocksOptions, "network" | "from" | "to"> & {
  graceBlocks?: number;
  bidderKeys?: BidderKey[];
};

/**
 * Download every block of the lot's range. By default each block comes from two public servers run
 * by different people, which must send the same bytes. No key is sent. Throws BlockFetchError if
 * that cannot be done; the error still lists every server contacted.
 */
export async function fetchScan(d: RangeFacts, opts: FetchScanOptions = {}): Promise<ScanInput> {
  const { graceBlocks, bidderKeys, ...fetchOpts } = opts;
  const range = scanRange(d, graceBlocks ?? DEFAULT_GRACE_BLOCKS);
  const fetched = await fetchBlocks({ ...fetchOpts, network: d.network, from: range.from, to: range.to });
  return { blocks: fetched.blocks, missing: [], source: fetched.source, graceBlocks: range.graceBlocks, bidderKeys };
}
