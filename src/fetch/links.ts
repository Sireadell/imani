// Each block names the block before it by hash. If a server hands over a range of blocks that do
// not chain together, it is mixing blocks from different histories, and the range is refused.
// This only compares what the servers sent: it cannot tell a real chain from a complete,
// consistent fake one (that is what asking two independent operators is for).

export interface BlockLink {
  height: number;
  hash: string;
  /** The hash of the block before this one, when the server gave it. */
  prevHash?: string;
}

/**
 * Checks that every block links to the block right before it. Only neighbours that are both
 * present are compared; a gap in the range is not this check's business (missing blocks are
 * reported where they always were), and a block with no previous hash is skipped.
 * Returns null when all links hold, or a plain message naming the first block that fails.
 */
export function checkBlockLinks(blocks: BlockLink[]): string | null {
  const byHeight = new Map<number, BlockLink>();
  for (const b of blocks) byHeight.set(b.height, b);
  for (const b of [...blocks].sort((x, y) => x.height - y.height)) {
    const before = byHeight.get(b.height - 1);
    if (!before || b.prevHash === undefined || !before.hash) continue;
    if (b.prevHash.toLowerCase() !== before.hash.toLowerCase()) {
      return `block ${b.height} does not link to block ${before.height}: it says the block before it is ${b.prevHash}, but block ${before.height} is ${before.hash}. The servers sent blocks that do not belong to one chain. Not using them.`;
    }
  }
  return null;
}
