// Minimal gRPC client for the light wallet server protocol (lightwalletd and Zaino),
// written on node:http2 so the project needs no extra dependency.
// Message layouts follow walletrpc/service.proto and compact_formats.proto in
// github.com/zcash/lightwallet-protocol (MIT).
// Only the three calls the fetch helper needs are encoded: GetTransaction, GetBlock
// and GetLightdInfo. Nothing here ever sends a key: requests carry a txid or a height.

import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";

const SERVICE = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";

// ---------- protobuf, just enough ----------

function varint(n: bigint): Buffer {
  if (n < 0n) throw new Error("protobuf: negative value");
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}

export function fieldVarint(field: number, n: bigint): Buffer {
  return Buffer.concat([varint(BigInt((field << 3) | 0)), varint(n)]);
}

export function fieldBytes(field: number, b: Buffer): Buffer {
  return Buffer.concat([varint(BigInt((field << 3) | 2)), varint(BigInt(b.length)), b]);
}

export type Field = { field: number; varint?: bigint; bytes?: Buffer };

/** Decodes the top level of a protobuf message. Unknown wire types are an error. */
export function decodeMessage(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const readVarint = (): bigint => {
    let shift = 0n;
    let v = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("protobuf: truncated varint");
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
      if (shift > 70n) throw new Error("protobuf: varint too long");
    }
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ field, varint: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > buf.length) throw new Error("protobuf: truncated field");
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error(`protobuf: unsupported wire type ${wire}`);
  }
  return out;
}

/** txid in display hex (as explorers show it) to protocol byte order, and back. */
export const txidToBytes = (hex: string) => Buffer.from(hex, "hex").reverse();
export const bytesToTxid = (b: Buffer) => Buffer.from(b).reverse().toString("hex");

export function encodeTxFilter(txidHex: string): Buffer {
  return fieldBytes(3, txidToBytes(txidHex));
}

export function encodeBlockId(height: number): Buffer {
  return fieldVarint(1, BigInt(height));
}

export function decodeRawTransaction(buf: Buffer): { data: Buffer; height: bigint } {
  let data = Buffer.alloc(0);
  let height = 0n;
  for (const f of decodeMessage(buf)) {
    if (f.field === 1 && f.bytes) data = Buffer.from(f.bytes);
    if (f.field === 2 && f.varint !== undefined) height = f.varint;
  }
  return { data, height };
}

/** From a CompactBlock: height, block hash (display hex) and the txids in block order. */
export function decodeCompactBlock(buf: Buffer): { height: number; hash: string; prevHash?: string; txids: string[] } {
  let height = 0;
  let hash = "";
  let prevHash: string | undefined;
  const txids: string[] = [];
  for (const f of decodeMessage(buf)) {
    if (f.field === 2 && f.varint !== undefined) height = Number(f.varint);
    if (f.field === 3 && f.bytes) hash = bytesToTxid(f.bytes);
    if (f.field === 4 && f.bytes && f.bytes.length === 32) prevHash = bytesToTxid(f.bytes);
    if (f.field === 7 && f.bytes) {
      for (const t of decodeMessage(f.bytes)) if (t.field === 2 && t.bytes) txids.push(bytesToTxid(t.bytes));
    }
  }
  return { height, hash, prevHash, txids };
}

export function decodeLightdInfo(buf: Buffer): { version: string; vendor: string; chainName: string; blockHeight: number } {
  const r = { version: "", vendor: "", chainName: "", blockHeight: 0 };
  for (const f of decodeMessage(buf)) {
    if (f.field === 1 && f.bytes) r.version = f.bytes.toString("utf8");
    if (f.field === 2 && f.bytes) r.vendor = f.bytes.toString("utf8");
    if (f.field === 4 && f.bytes) r.chainName = f.bytes.toString("utf8");
    if (f.field === 7 && f.varint !== undefined) r.blockHeight = Number(f.varint);
  }
  return r;
}

// ---------- transport ----------

export interface CallOptions {
  timeoutMs: number;
  /** Optional SOCKS5 proxy such as "socks5h://127.0.0.1:9050" (Tor). Host names are resolved by the proxy. */
  proxy?: string;
  /** Largest reply accepted, in bytes. */
  maxBytes?: number;
}

/** Server address: "https://host:port" (TLS) or "http://host:port" (plain, for local servers). */
export function parseServer(server: string): { url: URL; tls: boolean; host: string; port: number } {
  const url = new URL(server);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`server must start with https:// or http://: ${server}`);
  if (url.pathname !== "/" || url.search || url.username || url.password) throw new Error(`server must be just scheme, host and port: ${server}`);
  const isTls = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;
  return { url, tls: isTls, host: url.hostname, port };
}

/** Opens a TCP connection to host:port through a SOCKS5 proxy (no login). */
export function socks5Connect(proxy: string, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const p = new URL(proxy);
  if (p.protocol !== "socks5:" && p.protocol !== "socks5h:") throw new Error("proxy must be socks5://host:port or socks5h://host:port");
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(p.port || 1080), p.hostname);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("proxy timeout"));
    }, timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    sock.once("error", fail);
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on("data", function onData(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error("proxy refused: no-auth SOCKS5 method not accepted"));
        buf = buf.subarray(2);
        stage = 1;
        const name = Buffer.from(host, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port);
        // Always send the host name, never a locally resolved address, so DNS goes through the proxy.
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBuf]));
      } else if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error(`proxy could not connect (SOCKS5 code ${buf[1]})`));
        const atyp = buf[3];
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        sock.off("data", onData);
        sock.off("error", fail);
        clearTimeout(timer);
        resolve(sock);
      }
    });
    sock.once("connect", () => sock.write(Buffer.from([5, 1, 0])));
  });
}

/**
 * One unary gRPC call. Opens a fresh HTTP/2 connection and closes it after, so no
 * connection is reused between servers or between calls.
 */
export async function unary(server: string, method: string, request: Buffer, opts: CallOptions): Promise<Buffer> {
  const s = parseServer(server);
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let connectOpts: http2.SecureClientSessionOptions = {};
  if (opts.proxy) {
    const raw = await socks5Connect(opts.proxy, s.host, s.port, opts.timeoutMs);
    connectOpts = {
      createConnection: () => (s.tls ? tls.connect({ socket: raw, servername: s.host, ALPNProtocols: ["h2"] }) : raw),
    };
  }
  const authority = `${s.tls ? "https" : "http"}://${s.host.includes(":") ? `[${s.host}]` : s.host}:${s.port}`;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const session = http2.connect(authority, connectOpts);
    const done = (err: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      session.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error(`timeout after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    session.on("error", (e) => done(e));

    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(request.length, 1);
    const req = session.request({
      ":method": "POST",
      ":path": SERVICE + method,
      "content-type": "application/grpc",
      te: "trailers",
      "user-agent": "grpc-node",
    });
    req.on("error", (e) => done(e));
    const chunks: Buffer[] = [];
    let total = 0;
    let httpStatus = 0;
    let headerGrpcStatus: string | undefined;
    req.on("response", (h) => {
      httpStatus = Number(h[":status"]);
      if (h["grpc-status"] !== undefined) headerGrpcStatus = String(h["grpc-status"]);
    });
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) return done(new Error(`reply larger than ${maxBytes} bytes`));
      chunks.push(c);
    });
    req.on("trailers", (t) => {
      if (t["grpc-status"] !== undefined) headerGrpcStatus = String(t["grpc-status"]);
      if (headerGrpcStatus && headerGrpcStatus !== "0") {
        const msg = t["grpc-message"] ? decodeURIComponent(String(t["grpc-message"])) : "";
        done(new Error(`grpc status ${headerGrpcStatus}${msg ? `: ${msg}` : ""}`));
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (httpStatus !== 200) return done(new Error(`http status ${httpStatus}`));
      if (headerGrpcStatus === undefined) return done(new Error("reply ended without a grpc status"));
      if (headerGrpcStatus !== "0") return done(new Error(`grpc status ${headerGrpcStatus}`));
      const body = Buffer.concat(chunks);
      if (body.length < 5) return done(new Error("empty grpc reply"));
      if (body[0] !== 0) return done(new Error("compressed grpc replies are not supported"));
      const len = body.readUInt32BE(1);
      if (body.length !== 5 + len) return done(new Error("grpc reply length does not match its frame"));
      done(null, body.subarray(5));
    });
    req.end(Buffer.concat([frame, request]));
  });
}
