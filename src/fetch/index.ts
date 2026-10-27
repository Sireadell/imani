// Fetch helper: gets raw Zcash transactions from public servers, checks each one against
// its txid, and by default insists that two servers run by different operators return
// exactly the same bytes. Nothing in imani calls this unless the caller opts in; the
// checker and the login kit stay offline by default. See docs/fetch/DESIGN.md.
//
// What a server learns: the txids or block heights you ask for, your IP address (unless
// you pass a SOCKS5 proxy such as Tor), and the time. Never a key: this module has no
// parameter that takes one.

import {
  unary,
  parseServer,
  encodeTxFilter,
  encodeBlockId,
  decodeRawTransaction,
  decodeCompactBlock,
  decodeLightdInfo,
} from "./grpc.ts";
import { EXPLORER_PREFIX, explorerGetBlock, explorerGetTransaction } from "./explorer.ts";
import { isZebra, zebraBase, zebraChain, zebraGetBlock, zebraGetTransaction, zebraTip } from "./zebra.ts";
import { checkTxBytes, TXID_RE } from "./verify.ts";

import { DEFAULT_SERVERS, type Network } from "./servers.ts";
export { DEFAULT_SERVERS, type Network };

export interface FetchOptions {
  network: Network;
  /** Transaction ids in display hex (as explorers show them). */
  txids?: string[];
  /** Block heights. Every transaction in each block is fetched, which hides which one you want. */
  heights?: number[];
  /** Replaces the default list. */
  servers?: string[];
  /** Require two servers from different operators to return identical bytes. Default true. */
  crossCheck?: boolean;
  /** Per request. Default 15000. */
  timeoutMs?: number;
  /** Extra attempts per server after a network error. Default 1. */
  retries?: number;
  /** SOCKS5 proxy for every connection, e.g. "socks5h://127.0.0.1:9050" for a local Tor. */
  proxy?: string;
  /** Password for zebra+ sources, as "user:password" (see loadZebraAuth in ./zebra.ts). Sent only to zebra+ sources, never printed. */
  zebraAuth?: string;
}

export interface FetchedTx {
  txid: string;
  hex: string;
  /** Block height, when a light server reported the transaction as mined in the main chain. */
  height?: number;
  /** First server that returned verified bytes. */
  server: string;
  /** Every server that returned the same verified bytes. */
  confirmedBy: string[];
}

export interface FetchResult {
  transactions: FetchedTx[];
  /** Every server this call opened a connection to, in order. Print it to the user. */
  serversContacted: string[];
  /** Non-fatal problems: servers that timed out, refused, or sent bytes that failed the txid check. */
  problems: { server: string; error: string }[];
}

// Plain fields (not constructor parameter properties) so Node can run this file directly.
export class FetchError extends Error {
  readonly serversContacted: string[];
  readonly problems: { server: string; error: string }[];
  constructor(message: string, serversContacted: string[], problems: { server: string; error: string }[]) {
    super(message);
    this.name = "FetchError";
    this.serversContacted = serversContacted;
    this.problems = problems;
  }
}

const MAX_HEIGHT_SENTINEL = 2n ** 63n;

/** Who runs a server, roughly: the last two labels of the host name, or host:port for addresses. */
export function operatorOf(server: string): string {
  const s = parseServer(bareAddress(server));
  const host = s.host.replace(/^\[|\]$/g, "");
  if (/^[0-9.]+$/.test(host) || host.includes(":") || !host.includes(".")) return `${host}:${s.port}`;
  return host.split(".").slice(-2).join(".");
}

const isExplorer = (s: string) => s.startsWith(EXPLORER_PREFIX);

/** The http(s) address inside a source written as cipherscan:..., zebra+... or a plain light server address. */
const bareAddress = (s: string) => (isExplorer(s) ? s.slice(EXPLORER_PREFIX.length) : isZebra(s) ? zebraBase(s) : s);

function validateServers(list: string[]): string[] {
  if (!Array.isArray(list) || list.length === 0) throw new Error("no servers given");
  for (const s of list) parseServer(bareAddress(s));
  return [...new Set(list)];
}

/**
 * Fetch raw transactions by txid, or every transaction in some blocks by height.
 * Returns only bytes whose recomputed txid matches. Throws FetchError (which also carries
 * the servers contacted) when a txid cannot be verified, or when servers disagree.
 */
export async function fetchTransactions(opts: FetchOptions): Promise<FetchResult> {
  if (opts.network !== "main" && opts.network !== "test") throw new Error('network must be "main" or "test"');
  const txidsIn = (opts.txids ?? []).map((t) => String(t).trim().toLowerCase());
  for (const t of txidsIn) if (!TXID_RE.test(t)) throw new Error(`not a txid (64 hex characters): ${t.slice(0, 80)}`);
  const heights = opts.heights ?? [];
  for (const h of heights) if (!Number.isSafeInteger(h) || h < 1) throw new Error(`not a block height: ${h}`);
  if (txidsIn.length === 0 && heights.length === 0) throw new Error("give txids or heights");

  const servers = validateServers(opts.servers ?? DEFAULT_SERVERS[opts.network]);
  const need = opts.crossCheck === false ? 1 : 2;
  const call = { timeoutMs: opts.timeoutMs ?? 15000, proxy: opts.proxy };
  const zebraCall = { ...call, auth: opts.zebraAuth };
  // A Zebra node hands over a whole block with every transaction in one reply; keep it so the
  // transaction step below does not ask the same node again.
  const zebraBlocks = new Map<string, Map<string, string>>();
  const retries = opts.retries ?? 1;

  const contacted: string[] = [];
  const problems: { server: string; error: string }[] = [];
  const networkOk = new Map<string, boolean>();
  const touch = (s: string) => {
    if (!contacted.includes(s)) contacted.push(s);
  };
  const fail = (msg: string): never => {
    throw new FetchError(msg, contacted, problems);
  };

  async function withRetry<T>(server: string, f: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i <= retries; i++) {
      touch(server);
      try {
        return await f();
      } catch (e) {
        last = e;
        // A clear "not found" or a grpc error is an answer, not a network hiccup.
        if (/http status 404|grpc status|node error|refused the password|wants a password|refusing to send|not in the address/.test(String((e as Error).message))) break;
      }
    }
    throw last;
  }

  /** Light servers report their chain; refuse one that serves the other network. */
  async function checkNetwork(server: string): Promise<boolean> {
    if (isExplorer(server)) return true;
    if (networkOk.has(server)) return networkOk.get(server)!;
    try {
      if (isZebra(server)) {
        const chain = await withRetry(server, () => zebraChain(server, zebraCall));
        const ok = chain === opts.network;
        if (!ok) problems.push({ server, error: `serves the "${chain}" network, not "${opts.network}"` });
        networkOk.set(server, ok);
        return ok;
      }
      const info = decodeLightdInfo(await withRetry(server, () => unary(server, "GetLightdInfo", Buffer.alloc(0), call)));
      const ok = info.chainName === opts.network;
      if (!ok) problems.push({ server, error: `serves the "${info.chainName}" network, not "${opts.network}"` });
      networkOk.set(server, ok);
      return ok;
    } catch (e) {
      problems.push({ server, error: (e as Error).message });
      networkOk.set(server, false);
      return false;
    }
  }

  // ---- heights: list the block's txids, agreed by `need` operators ----
  const heightOf = new Map<string, number>();
  const wanted: string[] = [...txidsIn];
  for (const h of heights) {
    const lists: { server: string; key: string; txids: string[] }[] = [];
    const ops = new Set<string>();
    for (const server of servers) {
      if (lists.length >= need) break;
      if (ops.has(operatorOf(server))) continue;
      // An explorer only counts as a second opinion: at least one light server must have answered.
      if (isExplorer(server) && lists.length === 0) continue;
      if (!isExplorer(server) && !(await checkNetwork(server))) continue;
      try {
        let zb: Awaited<ReturnType<typeof zebraGetBlock>> | undefined;
        if (isZebra(server)) {
          zb = await withRetry(server, () => zebraGetBlock(server, h, zebraCall));
          zebraBlocks.set(`${server}#${h}`, new Map(zb.txs.map((t) => [t.txid, t.hex])));
        }
        const b = zb
          ? zb
          : isExplorer(server)
          ? await withRetry(server, () => explorerGetBlock(server.slice(EXPLORER_PREFIX.length), h, call))
          : decodeCompactBlock(await withRetry(server, () => unary(server, "GetBlock", encodeBlockId(h), call)));
        if (b.height !== h || b.txids.length === 0) throw new Error(`block ${h} not returned`);
        lists.push({ server, key: `${b.hash}:${b.txids.join(",")}`, txids: b.txids });
        ops.add(operatorOf(server));
      } catch (e) {
        problems.push({ server, error: `block ${h}: ${(e as Error).message}` });
      }
    }
    if (lists.length < need) {
      const why = [...new Set(problems.filter((p) => p.error.startsWith(`block ${h}:`) || !p.error.startsWith("block ")).map((p) => `${p.server}: ${p.error}`))].slice(-2);
      fail(`could not get block ${h} from ${need} independent servers${why.length ? ` (${why.join("; ")})` : ""}`);
    }
    if (lists.some((l) => l.key !== lists[0].key)) fail(`servers disagree about block ${h}: ${lists.map((l) => l.server).join(" vs ")}`);
    for (const t of lists[0].txids) {
      heightOf.set(t, h);
      if (!wanted.includes(t)) wanted.push(t);
    }
  }

  // ---- transactions: walk servers in order; each one is asked only for what is still missing ----
  const copies = new Map<string, { server: string; hex: string; height?: number }[]>();
  for (const t of wanted) copies.set(t, []);
  const missing = () => wanted.filter((t) => copies.get(t)!.length < need);

  for (const server of servers) {
    const todo = missing().filter((t) => !copies.get(t)!.some((c) => operatorOf(c.server) === operatorOf(server)));
    if (todo.length === 0) {
      if (missing().length === 0) break;
      continue;
    }
    if (!(await checkNetwork(server))) continue;
    for (const t of todo) {
      let hex: string;
      let height: number | undefined;
      try {
        if (isZebra(server)) {
          const cached = [...zebraBlocks].find(([k, m]) => k.startsWith(`${server}#`) && m.has(t));
          if (cached) {
            hex = cached[1].get(t)!;
            height = Number(cached[0].slice(server.length + 1));
          } else {
            const r = await withRetry(server, () => zebraGetTransaction(server, t, zebraCall));
            hex = r.hex;
            height = r.height;
          }
        } else if (isExplorer(server)) {
          hex = (await withRetry(server, () => explorerGetTransaction(server.slice(EXPLORER_PREFIX.length), t, call))).hex;
        } else {
          const raw = decodeRawTransaction(await withRetry(server, () => unary(server, "GetTransaction", encodeTxFilter(t), call)));
          hex = raw.data.toString("hex");
          if (raw.height > 0n && raw.height < MAX_HEIGHT_SENTINEL - 1n) height = Number(raw.height);
        }
      } catch (e) {
        problems.push({ server, error: `${t}: ${(e as Error).message}` });
        continue;
      }
      const bad = checkTxBytes(hex, t);
      if (bad) {
        problems.push({ server, error: `${t}: ${bad}` });
        continue;
      }
      const list = copies.get(t)!;
      if (list.length > 0 && list[0].hex !== hex) {
        fail(`servers returned different bytes for ${t}: ${list[0].server} vs ${server}. Both match the txid, so one server changed the signatures or proofs part. Not using either.`);
      }
      list.push({ server, hex, height });
    }
  }

  const still = missing();
  if (still.length > 0) {
    const why = need === 2 ? " from two servers run by different operators" : "";
    fail(`could not get verified bytes${why} for: ${still.join(", ")}`);
  }

  const transactions: FetchedTx[] = wanted.map((t) => {
    const list = copies.get(t)!;
    const reported = list.map((c) => c.height).filter((x): x is number => x !== undefined);
    // A height is given only when every light server that reported one agrees.
    let height: number | undefined = reported.length > 0 && reported.every((x) => x === reported[0]) ? reported[0] : undefined;
    const fromBlock = heightOf.get(t);
    if (fromBlock !== undefined && height !== undefined && height !== fromBlock) height = undefined;
    if (fromBlock !== undefined && height === undefined && reported.length === 0) height = fromBlock;
    return { txid: t, hex: list[0].hex, height, server: list[0].server, confirmedBy: list.map((c) => c.server) };
  });
  return { transactions, serversContacted: contacted, problems };
}

export interface ChainTipOptions {
  network: Network;
  servers?: string[];
  /** Ask two servers run by different operators when two are on the list. Default true. */
  crossCheck?: boolean;
  timeoutMs?: number;
  proxy?: string;
  zebraAuth?: string;
}

/**
 * The newest block height the servers have. Explorers are skipped (they are only ever a second
 * opinion). With cross-checking on, up to two operators are asked and the lower height is used,
 * so every block up to it is on both. One answer is enough: the tip only decides how far to
 * read, and every block read is still checked as usual, so a wrong tip can make a read shorter
 * or make it fail, never make it pass. Throws FetchError when no server answers.
 */
export async function fetchChainTip(opts: ChainTipOptions): Promise<{ height: number; serversContacted: string[] }> {
  if (opts.network !== "main" && opts.network !== "test") throw new Error('network must be "main" or "test"');
  const servers = validateServers(opts.servers ?? DEFAULT_SERVERS[opts.network]).filter((s) => !isExplorer(s));
  const want = opts.crossCheck === false ? 1 : 2;
  const call = { timeoutMs: opts.timeoutMs ?? 15000, proxy: opts.proxy };
  const contacted: string[] = [];
  const problems: { server: string; error: string }[] = [];
  const heights: number[] = [];
  const ops = new Set<string>();
  for (const server of servers) {
    if (heights.length >= want) break;
    if (ops.has(operatorOf(server))) continue;
    if (!contacted.includes(server)) contacted.push(server);
    try {
      let chain: string;
      let height: number;
      if (isZebra(server)) ({ chain, height } = await zebraTip(server, { ...call, auth: opts.zebraAuth }));
      else {
        const info = decodeLightdInfo(await unary(server, "GetLightdInfo", Buffer.alloc(0), call));
        chain = info.chainName;
        height = info.blockHeight;
      }
      if (chain !== opts.network) throw new Error(`serves the "${chain}" network, not "${opts.network}"`);
      if (!Number.isSafeInteger(height) || height < 1) throw new Error("reported no block height");
      heights.push(height);
      ops.add(operatorOf(server));
    } catch (e) {
      problems.push({ server, error: (e as Error).message });
    }
  }
  if (heights.length === 0) {
    const why = problems.slice(-2).map((p) => `${p.server}: ${p.error}`);
    throw new FetchError(`could not get the newest block height from any server${why.length ? ` (${why.join("; ")})` : ""}`, contacted, problems);
  }
  return { height: Math.min(...heights), serversContacted: contacted };
}
