// Serves the built site/ folder and the one thing the referee page needs from the network:
// blocks. Run: node tools/referee-serve.ts   (port 8789, or set IMANI_REFEREE_PORT)
//
// Why this exists: the two public block servers Imani's --fetch uses (a light wallet server and
// an explorer) do not allow requests from a web page (no CORS headers; checked 2026-10-19), so a
// browser cannot ask them directly. This small program asks them for the page, using the same
// code as --fetch: two servers run by different operators must return identical bytes for every
// transaction, or the block is refused. The page sends this program a network name and a block
// height, nothing else. It has no way to receive a key, and it asks no server for anything but
// blocks. It listens on this computer only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DEFAULT_SERVERS, fetchTransactions, FetchError, operatorOf, type Network } from "../src/fetch/index.ts";
import { decodeCompactBlock, encodeBlockId, unary } from "../src/fetch/grpc.ts";
import { EXPLORER_PREFIX, explorerGetBlock } from "../src/fetch/explorer.ts";
import { buildSite } from "./site-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

export function makeHandler(dir: string, block: (n: Network, h: number) => Promise<BlockReply> = (n, h) => limited(() => blockReply(n, h))) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/block") {
      // Only this site's own page may ask.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(403, "Not allowed");
      const network = url.searchParams.get("network");
      const height = Number(url.searchParams.get("height"));
      if ((network !== "main" && network !== "test") || !Number.isSafeInteger(height) || height < 1) return send(400, "Bad request");
      if ([...url.searchParams.keys()].some((k) => k !== "network" && k !== "height")) return send(400, "Bad request");
      try {
        return send(200, JSON.stringify(await block(network, height)), "application/json");
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        return send(502, JSON.stringify({ error: msg, serversContacted: e instanceof FetchError ? e.serversContacted : [] }), "application/json");
      }
    }
    const name = url.pathname === "/" ? "/check.html" : decodeURIComponent(url.pathname);
    const file = resolve(dir, "." + name);
    if (!file.startsWith(dir) || !existsSync(file)) return send(404, "Not found");
    send(200, readFileSync(file), types[extname(file)] ?? "application/octet-stream");
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = join(root, "site");
  if (!existsSync(join(dir, "check.html"))) await buildSite(dir);
  const port = Number(process.env.IMANI_REFEREE_PORT ?? 8789);
  createServer(makeHandler(dir)).listen(port, "127.0.0.1", () => {
    console.log(`Imani referee page: http://127.0.0.1:${port}/check.html  (Ctrl+C to stop)`);
    console.log(`Block servers it may contact: main ${DEFAULT_SERVERS.main.join(", ")}`);
    console.log(`                              test ${DEFAULT_SERVERS.test.join(", ")}`);
  });
}
