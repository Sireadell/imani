// Zebra route: reads blocks straight from a Zebra node (zebrad) over its JSON-RPC port.
// A source is written "zebra+http://127.0.0.1:18232" (or zebra+https://). Methods used, checked
// against ZcashFoundation/zebra zebra-rpc on 2026-10-19:
//   getblockchaininfo        -> { chain: "main" | "test", ... }  (the network check)
//   getblock "<height>" 2    -> { hash, height, tx: [{ txid, hex, ... }] }  (a block and every raw transaction)
//   getrawtransaction <txid> 1 -> { hex, height?, ... }  (one transaction)
// The height goes in as a string, as Zebra's getblock documents. Transactions are never parsed
// by hand here: every hex string goes through the same librustzcash check as the other routes,
// which recomputes the txid from the bytes.
//
// Password: Zebra's RPC port asks for HTTP Basic auth by default. Zebra writes a ".cookie" file
// in its cookie directory holding "__cookie__:<secret>"; only the part after the first ":" is
// checked, the user name is ignored. The secret is read from a file or an environment variable,
// never from the command line or the server address, and is never put in an error message.

import { readFileSync } from "node:fs";
import { getJson, type GetOptions } from "./explorer.ts";

export const ZEBRA_PREFIX = "zebra+";

/** Environment variable that can hold the password as "user:password" or the cookie file's text. */
export const ZEBRA_AUTH_ENV = "IMANI_ZEBRA_AUTH";

export const isZebra = (server: string) => server.startsWith(ZEBRA_PREFIX);

/** The http(s) address inside a zebra+ source. */
export const zebraBase = (server: string) => server.slice(ZEBRA_PREFIX.length);

/** True for the machine itself and private network ranges, where a plain http password is not sent over the internet. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Reads the node password. A file (Zebra's ".cookie", or any file holding user:password) wins
 * over the environment variable. Returns undefined when neither is given. Errors never contain
 * the secret.
 */
export function loadZebraAuth(file?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  let text: string | undefined;
  if (file) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(`could not read the Zebra password file ${file}`);
    }
  } else if (env[ZEBRA_AUTH_ENV]) {
    text = env[ZEBRA_AUTH_ENV];
  }
  if (text === undefined) return undefined;
  const t = text.trim();
  if (!t || /[\r\n]/.test(t)) throw new Error(file ? `the Zebra password file ${file} must hold one line` : `${ZEBRA_AUTH_ENV} must hold one line`);
  // A bare secret (no colon) is taken as the password with an empty user name.
  return t.includes(":") ? t : `:${t}`;
}

export interface ZebraCall extends GetOptions {
  /** "user:password", as returned by loadZebraAuth. */
  auth?: string;
}

/** One JSON-RPC call. Throws a short message; never includes the password. */
async function rpc(server: string, method: string, params: unknown[], opts: ZebraCall): Promise<unknown> {
  const base = zebraBase(server);
  const u = new URL(base);
  if (u.username || u.password) throw new Error("put the password in a file (--zebra-auth-file) or the environment, not in the address");
  if (opts.auth && u.protocol === "http:" && !isLocalHost(u.hostname)) {
    throw new Error("refusing to send a password over plain http to a machine that is not yours; use zebra+https:// or a local address");
  }
  const headers = opts.auth ? { authorization: `Basic ${Buffer.from(opts.auth).toString("base64")}` } : undefined;
  let reply: { status: number; body: unknown };
  try {
    reply = await getJson(base, { ...opts, maxBytes: opts.maxBytes ?? 64 * 1024 * 1024, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), headers });
  } catch (e) {
    const m = (e as Error).message;
    if (/http status 40[13]/.test(m)) throw new Error(opts.auth ? "the node refused the password" : "the node wants a password (give --zebra-auth-file, or set " + ZEBRA_AUTH_ENV + ")");
    throw e;
  }
  if (reply.status === 401 || reply.status === 403) {
    throw new Error(opts.auth ? "the node refused the password" : "the node wants a password (give --zebra-auth-file, or set " + ZEBRA_AUTH_ENV + ")");
  }
  const b = reply.body as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (b && typeof b === "object" && b.error) {
    throw new Error(`node error ${String(b.error.code)}: ${String(b.error.message).slice(0, 120)}`);
  }
  if (reply.status !== 200 || !b || typeof b !== "object" || !("result" in b)) throw new Error(`http status ${reply.status}, no result`);
  return b.result;
}

/** "main" or "test", as the node reports it. */
export async function zebraChain(server: string, opts: ZebraCall): Promise<string> {
  const r = (await rpc(server, "getblockchaininfo", [], opts)) as { chain?: unknown };
  if (typeof r?.chain !== "string") throw new Error("reply has no chain name");
  return r.chain;
}

const HASH_RE = /^[0-9a-f]{64}$/i;

/** One block: its hash, and every transaction as raw hex with the txid the node gave for it. */
export async function zebraGetBlock(server: string, height: number, opts: ZebraCall): Promise<{ height: number; hash: string; txids: string[]; txs: { txid: string; hex: string }[] }> {
  const r = (await rpc(server, "getblock", [String(height), 2], opts)) as { hash?: unknown; height?: unknown; tx?: unknown };
  if (typeof r?.hash !== "string" || !HASH_RE.test(r.hash) || !Array.isArray(r.tx)) throw new Error("reply has no block hash or transaction list");
  const txs: { txid: string; hex: string }[] = [];
  for (const t of r.tx as { txid?: unknown; hex?: unknown }[]) {
    if (typeof t?.txid !== "string" || !HASH_RE.test(t.txid) || typeof t.hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(t.hex)) {
      throw new Error("reply has a malformed transaction");
    }
    txs.push({ txid: t.txid.toLowerCase(), hex: t.hex.toLowerCase() });
  }
  return { height: Number(r.height), hash: r.hash.toLowerCase(), txids: txs.map((t) => t.txid), txs };
}

/** One transaction by id, with its block height when the node reports one. */
export async function zebraGetTransaction(server: string, txid: string, opts: ZebraCall): Promise<{ hex: string; height?: number }> {
  const r = (await rpc(server, "getrawtransaction", [txid, 1], opts)) as { hex?: unknown; height?: unknown };
  if (typeof r?.hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(r.hex)) throw new Error("reply has no transaction hex");
  const h = typeof r.height === "number" && Number.isSafeInteger(r.height) && r.height > 0 ? r.height : undefined;
  return { hex: r.hex.toLowerCase(), height: h };
}
