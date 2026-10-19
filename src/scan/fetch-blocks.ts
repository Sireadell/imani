// Live block download for the scan, used only when the caller passes --fetch.
// Each block is asked for by height through the fetch helper (src/fetch): two light
// servers run by different operators must agree on the block's transaction list, and two
// must return identical bytes for every transaction. No key is ever sent: the fetch helper
// has no parameter that takes one.
//
// Speed: the fetch helper opens one connection per request, so a block with ten
// transactions costs about twenty requests. Blocks are fetched a few at a time in parallel
// (`concurrency`) and progress is reported after each group.

import { fetchTransactions, FetchError, type Network } from "../fetch/index.ts";
import { EXPLORER_PREFIX } from "../fetch/explorer.ts";
import { isZebra } from "../fetch/zebra.ts";
import type { BlockSource, ChainBlock } from "./chain.ts";

export interface FetchBlocksOptions {
  network: Network;
  from: number;
  to: number;
  /** Replaces the default light server list. */
  servers?: string[];
  /** Require two operators to agree. Default true; the CLI turns it off for a single server you run yourself. */
  crossCheck?: boolean;
  /** SOCKS5 proxy, for example "socks5h://127.0.0.1:9050" for a local Tor. */
  proxy?: string;
  /** Password for zebra+ sources, "user:password". Sent only to those. */
  zebraAuth?: string;
  /** How many groups of blocks are downloaded at the same time. Default 12 (measured on mainnet, see SPEC.md). */
  concurrency?: number;
  /** Blocks per request group. Default 1. */
  groupSize?: number;
  timeoutMs?: number;
  /** Extra attempts for a group of blocks after a busy or dropped server. Default 3. */
  retries?: number;
  /** Pause before a retry, times the attempt number. Default 2000 ms. */
  retryPauseMs?: number;
  /** Called after each group with blocks done so far. */
  onProgress?: (done: number, total: number) => void;
}

export class BlockFetchError extends Error {
  readonly serversContacted: string[];
  constructor(message: string, serversContacted: string[]) {
    super(message);
    this.serversContacted = serversContacted;
  }
}

export async function fetchBlocks(opts: FetchBlocksOptions): Promise<{ blocks: ChainBlock[]; source: BlockSource }> {
  const { from, to } = opts;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new BlockFetchError(`not a valid block range: ${from} to ${to}`, []);
  }
  const heights: number[] = [];
  for (let h = from; h <= to; h++) heights.push(h);
  const groupSize = Math.max(1, opts.groupSize ?? 1);
  const groups: number[][] = [];
  for (let i = 0; i < heights.length; i += groupSize) groups.push(heights.slice(i, i + groupSize));

  const contacted: string[] = [];
  const touch = (list: string[]) => {
    for (const s of list) if (!contacted.includes(s)) contacted.push(s);
  };
  const byHeight = new Map<number, ChainBlock>();
  let bytes = 0;
  let done = 0;
  let failure: Error | null = null;
  const started = Date.now();

  // A busy server sometimes drops or refuses a request. That is retried (with a pause) up to
  // `retries` times. Servers that disagree, or send different bytes, are never retried: that
  // is a real warning and stops the scan.
  const retries = opts.retries ?? 3;
  const security = /disagree|different bytes|wants a password|refused the password|refusing to send/;
  let next = 0;
  async function getGroup(group: number[]) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchTransactions({
          network: opts.network,
          heights: group,
          servers: opts.servers,
          crossCheck: opts.crossCheck,
          proxy: opts.proxy,
          zebraAuth: opts.zebraAuth,
          timeoutMs: opts.timeoutMs,
        });
        touch(res.serversContacted);
        return res;
      } catch (e) {
        if (e instanceof FetchError) touch(e.serversContacted);
        if (attempt >= retries || security.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, (opts.retryPauseMs ?? 2000) * (attempt + 1)));
      }
    }
  }
  async function worker() {
    while (!failure && next < groups.length) {
      const group = groups[next++];
      try {
        const res = await getGroup(group);
        const local = new Map(group.map((h) => [h, { height: h, txs: [] } as ChainBlock]));
        let groupBytes = 0;
        for (const t of res.transactions) {
          if (t.height === undefined || !local.has(t.height)) {
            throw new Error(`the servers did not agree on the block of transaction ${t.txid}`);
          }
          local.get(t.height)!.txs.push({ txid: t.txid, txHex: t.hex });
          groupBytes += (t.hex.length / 2) * t.confirmedBy.length;
        }
        for (const [h, b] of local) byHeight.set(h, b);
        bytes += groupBytes;
        done += group.length;
        opts.onProgress?.(done, heights.length);
      } catch (e) {
        failure ??= e as Error;
      }
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency ?? 12, groups.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) {
    throw new BlockFetchError(`could not download every block from ${from} to ${to}: ${(failure as Error).message}`, contacted);
  }
  const blocks = heights.map((h) => byHeight.get(h)!);
  return {
    blocks,
    source: {
      kind: "light-servers",
      label:
        opts.crossCheck === false
          ? contacted.some(isZebra)
            ? "the Zebra node you chose (one source, trusted as your own, no second opinion)"
            : "the one server you chose (no second opinion)"
          : contacted.some(isZebra)
            ? "a Zebra node and another server, two independent operators agreeing on every block and every transaction"
            : contacted.some((s) => s.startsWith(EXPLORER_PREFIX))
              ? "a light server and an explorer, two independent operators agreeing on every block and every transaction"
              : "light servers, two independent operators agreeing on every block and every transaction",
      serversContacted: contacted,
      bytes,
      ms: Date.now() - started,
    },
  };
}
