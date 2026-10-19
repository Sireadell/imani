// The one network door the "check any round" page uses: GET /api/block?network=...&height=...
// Shared by the local helper (tools/referee-serve.ts) and the hosted site (api/block.mjs, built
// from src/relay/vercel.ts), so both answer the same way.
//
// Why it exists: the public block servers do not accept requests from a web page (no CORS
// headers; checked 2026-10-19), so the page cannot ask them directly. This code asks them, using
// the same fetch code as `imani check --fetch`: two servers run by different operators must
// return identical bytes for every transaction, or the block is refused. It accepts a network
// name and a block height, nothing else, so it has no way to receive a key.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { DEFAULT_SERVERS, fetchTransactions, FetchError, operatorOf, type Network } from "../fetch/index.ts";
import { decodeCompactBlock, encodeBlockId, unary } from "../fetch/grpc.ts";
import { EXPLORER_PREFIX, explorerGetBlock } from "../fetch/explorer.ts";

export interface BlockAnswer {
  server: string;
  hash: string;
  txCount: number;
  /** Short fingerprint of the ordered transaction id list this server returned. */
  digest: string;
}

export interface BlockReply {
  height: number;
  txs: { txid: string; txHex: string }[];
  /** What each of the two servers said about this block, side by side. */
  answers: BlockAnswer[];
  agree: boolean;
  serversContacted: string[];
}

/** What one server says a block holds: its hash and its transaction ids, in order. */
export async function describeBlock(server: string, height: number, timeoutMs = 15000): Promise<BlockAnswer> {
  const b = server.startsWith(EXPLORER_PREFIX)
    ? await explorerGetBlock(server.slice(EXPLORER_PREFIX.length), height, { timeoutMs })
    : decodeCompactBlock(await unary(server, "GetBlock", encodeBlockId(height), { timeoutMs }));
  return { server, hash: b.hash, txCount: b.txids.length, digest: createHash("sha256").update(b.txids.join(",")).digest("hex").slice(0, 16) };
}

export type Fetcher = typeof fetchTransactions;
export type Describer = typeof describeBlock;

/** One block, with every transaction verified against its id and agreed by two operators. */
export async function blockReply(network: Network, height: number, fetcher: Fetcher = fetchTransactions, describe: Describer = describeBlock): Promise<BlockReply> {
  // Ask the two usual servers what they say about the block while the transactions download.
  const early = new Map<string, Promise<BlockAnswer>>();
  const ask = (s: string) => (early.has(s) ? early.get(s)! : (early.set(s, describe(s, height)), early.get(s)!));
  const usual: string[] = [];
  for (const s of DEFAULT_SERVERS[network]) if (!usual.some((u) => operatorOf(u) === operatorOf(s))) usual.push(s);
  const head = usual.slice(0, 2).map((s) => ask(s).catch(() => null));
  const res = await fetcher({ network, heights: [height] });
  const txs = res.transactions.map((t) => ({ txid: t.txid, txHex: t.hex }));
  // The two servers that agreed: the first two operators this call opened a connection to.
  const picked: string[] = [];
  for (const s of res.serversContacted) if (!picked.some((p) => operatorOf(p) === operatorOf(s))) picked.push(s);
  const answers = await Promise.all(picked.slice(0, 2).map((s) => ask(s)));
  await Promise.all(head);
  const agree = answers.length === 2 && answers[0].digest === answers[1].digest && answers[0].hash === answers[1].hash;
  return { height, txs, answers, agree, serversContacted: res.serversContacted };
}

/** At most this many blocks are asked of the public servers at the same time, so a big range is polite to them. */
const MAX_AT_ONCE = 8;
let active = 0;
const waiting: (() => void)[] = [];
export async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_AT_ONCE) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export type BlockGetter = (n: Network, h: number) => Promise<BlockReply>;

export const realBlock: BlockGetter = (n, h) => limited(() => blockReply(n, h));

/**
 * Answers /api/block and nothing else. Returns false for any other path so a caller can serve
 * its own files; a caller with nothing else to serve answers 404 itself.
 */
export function answerBlock(req: IncomingMessage, res: ServerResponse, block: BlockGetter = realBlock): boolean | Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/block") return false;
  const send = (code: number, body: string, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(body);
    return true;
  };
  if (req.method !== "GET") return send(405, "Only GET");
  // Only this site's own page may ask.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return send(403, "Not allowed");
  const network = url.searchParams.get("network");
  const height = Number(url.searchParams.get("height"));
  if ((network !== "main" && network !== "test") || !Number.isSafeInteger(height) || height < 1) return send(400, "Bad request");
  if ([...url.searchParams.keys()].some((k) => k !== "network" && k !== "height")) return send(400, "Bad request");
  return block(network, height).then(
    (r) => send(200, JSON.stringify(r), "application/json"),
    (e) => send(502, JSON.stringify({ error: (e as Error).message.slice(0, 300), serversContacted: e instanceof FetchError ? e.serversContacted : [] }), "application/json"),
  );
}

/** A request handler that serves /api/block and answers 404 to everything else. */
export function blockApi(block: BlockGetter = realBlock) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!(await answerBlock(req, res, block))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Not found");
    }
  };
}
