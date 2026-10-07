// Blocks for the full-range scan. A scan reads every block in a height range. The blocks
// come either from a chain file on disk (offline, the default) or from public light
// servers (only with --fetch, see fetch-blocks.ts). Either way the scan sees the same shape.

/** One transaction inside a block. */
export interface ChainTx {
  /** Transaction id as the source states it. The scan recomputes it from the bytes. */
  txid: string;
  txHex: string;
}

/** One block: its height and every transaction in it. */
export interface ChainBlock {
  height: number;
  txs: ChainTx[];
}

/** Chain file: a stretch of blocks saved to disk so the scan can run with no network. */
export interface ChainFile {
  format: "imani-chain/1";
  network: "main" | "test";
  about?: string;
  blocks: ChainBlock[];
}

/** Where the blocks came from, so the report can say so plainly. */
export interface BlockSource {
  kind: "chain-file" | "light-servers";
  /** Shown to the user, for example the chain file name or "two light servers per block". */
  label: string;
  serversContacted: string[];
  /** Transaction bytes received (counting every copy from every server). */
  bytes: number;
  /** Time spent getting the blocks, in milliseconds. */
  ms: number;
}

/** A scan input problem (chain file, block range, bidder keys). The message is safe to print. */
export class ScanInputError extends Error {}

const TXID = /^[0-9a-f]{64}$/;

/** Check the shape of a chain file. Throws ScanInputError with a plain message. */
export function validateChainFile(c: any): asserts c is ChainFile {
  const bad = (what: string): never => {
    throw new ScanInputError(`Input error: chain file ${what}`);
  };
  if (!c || typeof c !== "object") bad("is not a JSON object.");
  if (c.format !== "imani-chain/1") bad('must have "format": "imani-chain/1".');
  if (c.network !== "main" && c.network !== "test") bad('needs "network": "main" or "test".');
  if (!Array.isArray(c.blocks)) bad("needs a blocks list.");
  const heights = new Set<number>();
  for (const b of c.blocks) {
    if (!b || !Number.isSafeInteger(b.height) || b.height < 1) bad("has a block without a whole positive height.");
    if (heights.has(b.height)) bad(`lists block ${b.height} twice.`);
    heights.add(b.height);
    if (!Array.isArray(b.txs)) bad(`block ${b.height} needs a txs list.`);
    for (const t of b.txs) {
      if (!t || typeof t.txid !== "string" || !TXID.test(t.txid)) bad(`block ${b.height} has a transaction without a 64 hex character txid.`);
      if (typeof t.txHex !== "string" || !/^([0-9a-f]{2})+$/i.test(t.txHex)) bad(`block ${b.height} has a transaction without txHex.`);
    }
  }
}

/**
 * Take the blocks from `from` to `to` (both included) out of a chain file.
 * Blocks outside the range are ignored. Missing blocks are returned in `missing`, never invented.
 */
export function blocksInRange(c: ChainFile, from: number, to: number): { blocks: ChainBlock[]; missing: number[] } {
  const byHeight = new Map(c.blocks.map((b) => [b.height, b]));
  const blocks: ChainBlock[] = [];
  const missing: number[] = [];
  for (let h = from; h <= to; h++) {
    const b = byHeight.get(h);
    if (b) blocks.push(b);
    else missing.push(h);
  }
  return { blocks, missing };
}
