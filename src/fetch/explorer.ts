// Explorer route: CipherScan's public JSON API, GET /api/tx/{txid}/raw, which returns
// { txid, hex }. Used as a second, independent source next to the light servers, mainly
// for the test network where only one public light server answered in October 2026.

import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { socks5Connect } from "./grpc.ts";

export const EXPLORER_PREFIX = "cipherscan:";

export interface GetOptions {
  timeoutMs: number;
  proxy?: string;
  maxBytes?: number;
  /** Send this body with a POST instead of a plain GET (used for JSON-RPC to a node). */
  body?: string;
  /** Extra request headers, for example a node's password. Never logged. */
  headers?: Record<string, string>;
}

/** GET (or, with a body, POST) a URL and parse JSON. Sends no cookies, no referrer and a generic user agent. */
export async function getJson(urlText: string, opts: GetOptions): Promise<{ status: number; body: unknown }> {
  const url = new URL(urlText);
  const isTls = url.protocol === "https:";
  if (!isTls && url.protocol !== "http:") throw new Error("explorer URL must be https:// or http://");
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let createConnection: (() => import("node:net").Socket) | undefined;
  if (opts.proxy) {
    const raw = await socks5Connect(opts.proxy, url.hostname, port, opts.timeoutMs);
    createConnection = () => (isTls ? tls.connect({ socket: raw, servername: url.hostname }) : raw);
  }
  const lib = isTls ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: opts.body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "user-agent": "node",
          ...(opts.body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(opts.body)) }),
          ...opts.headers,
        },
        agent: false,
        ...(createConnection ? { createConnection } : {}),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy(new Error(`reply larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error(`http status ${res.statusCode}, reply is not JSON`));
          }
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Fetch one raw transaction from a CipherScan-style API base such as https://api.testnet.cipherscan.app */
export async function explorerGetTransaction(base: string, txid: string, opts: GetOptions): Promise<{ hex: string }> {
  const { status, body } = await getJson(`${base.replace(/\/+$/, "")}/api/tx/${txid}/raw`, opts);
  if (status !== 200) throw new Error(`http status ${status}`);
  const hex = (body as { hex?: unknown })?.hex;
  if (typeof hex !== "string" || hex.length === 0) throw new Error("reply has no hex field");
  return { hex: hex.toLowerCase() };
}

/**
 * List one block's transactions from a CipherScan-style API: GET /api/block/{height}.
 * Gives the block hash and the transaction ids in block order, the same shape a light server's
 * compact block gives, so the two can be compared. On the test network this is the second
 * independent source for blocks, because only one public light server answered in October 2026.
 */
export async function explorerGetBlock(base: string, height: number, opts: GetOptions): Promise<{ height: number; hash: string; prevHash?: string; txids: string[] }> {
  const { status, body } = await getJson(`${base.replace(/\/+$/, "")}/api/block/${height}`, opts);
  if (status !== 200) throw new Error(`http status ${status}`);
  const b = body as { height?: unknown; hash?: unknown; transactions?: unknown; previousBlockHash?: unknown; previousblockhash?: unknown; prevHash?: unknown };
  const txs = Array.isArray(b.transactions) ? (b.transactions as { txid?: unknown }[]) : null;
  if (typeof b.hash !== "string" || !txs) throw new Error("reply has no block hash or transaction list");
  const txids = txs.map((t) => t.txid);
  if (!txids.every((t): t is string => typeof t === "string" && /^[0-9a-f]{64}$/i.test(t))) throw new Error("reply has a malformed transaction id");
  const prev = [b.previousBlockHash, b.previousblockhash, b.prevHash].find((x) => typeof x === "string" && /^[0-9a-f]{64}$/i.test(x)) as string | undefined;
  return { height: Number(b.height), hash: b.hash.toLowerCase(), prevHash: prev?.toLowerCase(), txids: txids.map((t) => t.toLowerCase()) };
}
