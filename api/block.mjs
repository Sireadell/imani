// Built by npm run relay:build from src/relay/vercel.ts. Do not edit by hand.

// src/relay/block-api.ts
import { createHash } from "node:crypto";

// src/fetch/grpc.ts
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
var SERVICE = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";
function varint(n) {
  if (n < 0n) throw new Error("protobuf: negative value");
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 128;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
function fieldVarint(field, n) {
  return Buffer.concat([varint(BigInt(field << 3 | 0)), varint(n)]);
}
function fieldBytes(field, b) {
  return Buffer.concat([varint(BigInt(field << 3 | 2)), varint(BigInt(b.length)), b]);
}
function decodeMessage(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let shift = 0n;
    let v = 0n;
    for (; ; ) {
      if (i >= buf.length) throw new Error("protobuf: truncated varint");
      const b = buf[i++];
      v |= BigInt(b & 127) << shift;
      if ((b & 128) === 0) return v;
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
var txidToBytes = (hex) => Buffer.from(hex, "hex").reverse();
var bytesToTxid = (b) => Buffer.from(b).reverse().toString("hex");
function encodeTxFilter(txidHex) {
  return fieldBytes(3, txidToBytes(txidHex));
}
function encodeBlockId(height) {
  return fieldVarint(1, BigInt(height));
}
function decodeRawTransaction(buf) {
  let data = Buffer.alloc(0);
  let height = 0n;
  for (const f of decodeMessage(buf)) {
    if (f.field === 1 && f.bytes) data = Buffer.from(f.bytes);
    if (f.field === 2 && f.varint !== void 0) height = f.varint;
  }
  return { data, height };
}
function decodeCompactBlock(buf) {
  let height = 0;
  let hash = "";
  const txids = [];
  for (const f of decodeMessage(buf)) {
    if (f.field === 2 && f.varint !== void 0) height = Number(f.varint);
    if (f.field === 3 && f.bytes) hash = bytesToTxid(f.bytes);
    if (f.field === 7 && f.bytes) {
      for (const t of decodeMessage(f.bytes)) if (t.field === 2 && t.bytes) txids.push(bytesToTxid(t.bytes));
    }
  }
  return { height, hash, txids };
}
function decodeLightdInfo(buf) {
  const r = { version: "", vendor: "", chainName: "", blockHeight: 0 };
  for (const f of decodeMessage(buf)) {
    if (f.field === 1 && f.bytes) r.version = f.bytes.toString("utf8");
    if (f.field === 2 && f.bytes) r.vendor = f.bytes.toString("utf8");
    if (f.field === 4 && f.bytes) r.chainName = f.bytes.toString("utf8");
    if (f.field === 7 && f.varint !== void 0) r.blockHeight = Number(f.varint);
  }
  return r;
}
function parseServer(server) {
  const url = new URL(server);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`server must start with https:// or http://: ${server}`);
  if (url.pathname !== "/" || url.search || url.username || url.password) throw new Error(`server must be just scheme, host and port: ${server}`);
  const isTls = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;
  return { url, tls: isTls, host: url.hostname, port };
}
function socks5Connect(proxy, host, port, timeoutMs) {
  const p = new URL(proxy);
  if (p.protocol !== "socks5:" && p.protocol !== "socks5h:") throw new Error("proxy must be socks5://host:port or socks5h://host:port");
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(p.port || 1080), p.hostname);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("proxy timeout"));
    }, timeoutMs);
    const fail = (e) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    sock.once("error", fail);
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on("data", function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error("proxy refused: no-auth SOCKS5 method not accepted"));
        buf = buf.subarray(2);
        stage = 1;
        const name = Buffer.from(host, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port);
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
async function unary(server, method, request, opts) {
  const s = parseServer(server);
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let connectOpts = {};
  if (opts.proxy) {
    const raw = await socks5Connect(opts.proxy, s.host, s.port, opts.timeoutMs);
    connectOpts = {
      createConnection: () => s.tls ? tls.connect({ socket: raw, servername: s.host, ALPNProtocols: ["h2"] }) : raw
    };
  }
  const authority = `${s.tls ? "https" : "http"}://${s.host.includes(":") ? `[${s.host}]` : s.host}:${s.port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const session = http2.connect(authority, connectOpts);
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      session.destroy();
      if (err) reject(err);
      else resolve(value);
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
      "user-agent": "grpc-node"
    });
    req.on("error", (e) => done(e));
    const chunks = [];
    let total = 0;
    let httpStatus = 0;
    let headerGrpcStatus;
    req.on("response", (h) => {
      httpStatus = Number(h[":status"]);
      if (h["grpc-status"] !== void 0) headerGrpcStatus = String(h["grpc-status"]);
    });
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) return done(new Error(`reply larger than ${maxBytes} bytes`));
      chunks.push(c);
    });
    req.on("trailers", (t) => {
      if (t["grpc-status"] !== void 0) headerGrpcStatus = String(t["grpc-status"]);
      if (headerGrpcStatus && headerGrpcStatus !== "0") {
        const msg = t["grpc-message"] ? decodeURIComponent(String(t["grpc-message"])) : "";
        done(new Error(`grpc status ${headerGrpcStatus}${msg ? `: ${msg}` : ""}`));
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (httpStatus !== 200) return done(new Error(`http status ${httpStatus}`));
      if (headerGrpcStatus === void 0) return done(new Error("reply ended without a grpc status"));
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

// src/fetch/explorer.ts
import https from "node:https";
import http from "node:http";
import tls2 from "node:tls";
var EXPLORER_PREFIX = "cipherscan:";
async function getJson(urlText, opts) {
  const url = new URL(urlText);
  const isTls = url.protocol === "https:";
  if (!isTls && url.protocol !== "http:") throw new Error("explorer URL must be https:// or http://");
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let createConnection;
  if (opts.proxy) {
    const raw = await socks5Connect(opts.proxy, url.hostname, port, opts.timeoutMs);
    createConnection = () => isTls ? tls2.connect({ socket: raw, servername: url.hostname }) : raw;
  }
  const lib = isTls ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "node" },
        agent: false,
        ...createConnection ? { createConnection } : {},
        timeout: opts.timeoutMs
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
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
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
async function explorerGetTransaction(base, txid, opts) {
  const { status, body } = await getJson(`${base.replace(/\/+$/, "")}/api/tx/${txid}/raw`, opts);
  if (status !== 200) throw new Error(`http status ${status}`);
  const hex = body?.hex;
  if (typeof hex !== "string" || hex.length === 0) throw new Error("reply has no hex field");
  return { hex: hex.toLowerCase() };
}
async function explorerGetBlock(base, height, opts) {
  const { status, body } = await getJson(`${base.replace(/\/+$/, "")}/api/block/${height}`, opts);
  if (status !== 200) throw new Error(`http status ${status}`);
  const b = body;
  const txs = Array.isArray(b.transactions) ? b.transactions : null;
  if (typeof b.hash !== "string" || !txs) throw new Error("reply has no block hash or transaction list");
  const txids = txs.map((t) => t.txid);
  if (!txids.every((t) => typeof t === "string" && /^[0-9a-f]{64}$/i.test(t))) throw new Error("reply has a malformed transaction id");
  return { height: Number(b.height), hash: b.hash.toLowerCase(), txids: txids.map((t) => t.toLowerCase()) };
}

// src/fetch/verify.ts
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var decoder = require2("../vendor/decoder/imani_decoder.js");
var TXID_ONLY_KEY = "uviewtest1q2ejsw2g7cp5zw0wuprqpgqhcsfdmw3wmxl5nh968epjml0v0hhpgtkufzmctmu0vupl33ys0u2gyfv77gtyq94xgv9dl05ul9d4m9kat80h3vg4rv7jrtx4q7wlcewvlwv4eh3jdsv9e9g5qjwv4czhsujkndnwpzqlrvafddnln04xg685d7zn488gwxc8h92av23n7hrgzknn9s3sptvdryw2mll5e0uw9gzjrk6vn7zn8jpcmq3xm20lfm2hcfstvm0g57w9y6e0d8759cuyhqqkkt7wmtp77tnxz5e4z3zspjct0y6lss6r8sxnp4u482aqfurg7y5ye7q3et06w2uevfx6xgqzjye9s7cf6497r93jcfefy3atsh242gvngrkssumxzxzvuctc4updgdlt235n8ctskpg9lnvm4h9pazrajs9chyqgzyf0y2f9ytnqkrry7ujs8kkdkj6gy4lc24qd9pqagqqqqj34ghzgrvmsnhtm";
var TXID_RE = /^[0-9a-f]{64}$/;
function computeTxid(txHex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(txHex)) throw new Error("transaction is not hex");
  const r = decoder.decryptTx(txHex, TXID_ONLY_KEY);
  if (!TXID_RE.test(r.txid)) throw new Error("decoder returned no txid");
  return { txid: r.txid, txVersion: r.txVersion, branchId: r.branchId };
}
function idOrNull(txHex) {
  try {
    return computeTxid(txHex).txid;
  } catch {
    return null;
  }
}
function checkTxBytes(txHex, expectedTxid) {
  const want = expectedTxid.toLowerCase();
  let got;
  try {
    got = computeTxid(txHex).txid;
  } catch (e) {
    return `could not read the transaction (${e.message})`;
  }
  if (got !== want) return `bytes hash to a different txid ${got}`;
  if (idOrNull(txHex.slice(0, -2)) === want) return "extra bytes after the end of the transaction";
  return null;
}

// src/fetch/servers.ts
var DEFAULT_SERVERS = {
  main: [
    "https://zec.rocks:443",
    "https://zec-node.cakewallet.com:443",
    "https://lwd.zcashexplorer.app:9067",
    "https://us.zec.stardust.rest:443",
    "https://zcash.mysideoftheweb.com:9067",
    "cipherscan:https://api.mainnet.cipherscan.app"
  ],
  test: ["https://testnet.zec.rocks:443", "cipherscan:https://api.testnet.cipherscan.app"]
};

// src/fetch/index.ts
var FetchError = class extends Error {
  serversContacted;
  problems;
  constructor(message, serversContacted, problems) {
    super(message);
    this.name = "FetchError";
    this.serversContacted = serversContacted;
    this.problems = problems;
  }
};
var MAX_HEIGHT_SENTINEL = 2n ** 63n;
function operatorOf(server) {
  const s = parseServer(server.startsWith(EXPLORER_PREFIX) ? server.slice(EXPLORER_PREFIX.length) : server);
  const host = s.host.replace(/^\[|\]$/g, "");
  if (/^[0-9.]+$/.test(host) || host.includes(":") || !host.includes(".")) return `${host}:${s.port}`;
  return host.split(".").slice(-2).join(".");
}
var isExplorer = (s) => s.startsWith(EXPLORER_PREFIX);
function validateServers(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("no servers given");
  for (const s of list) parseServer(isExplorer(s) ? s.slice(EXPLORER_PREFIX.length) : s);
  return [...new Set(list)];
}
async function fetchTransactions(opts) {
  if (opts.network !== "main" && opts.network !== "test") throw new Error('network must be "main" or "test"');
  const txidsIn = (opts.txids ?? []).map((t) => String(t).trim().toLowerCase());
  for (const t of txidsIn) if (!TXID_RE.test(t)) throw new Error(`not a txid (64 hex characters): ${t.slice(0, 80)}`);
  const heights = opts.heights ?? [];
  for (const h of heights) if (!Number.isSafeInteger(h) || h < 1) throw new Error(`not a block height: ${h}`);
  if (txidsIn.length === 0 && heights.length === 0) throw new Error("give txids or heights");
  const servers = validateServers(opts.servers ?? DEFAULT_SERVERS[opts.network]);
  const need = opts.crossCheck === false ? 1 : 2;
  const call = { timeoutMs: opts.timeoutMs ?? 15e3, proxy: opts.proxy };
  const retries = opts.retries ?? 1;
  const contacted = [];
  const problems = [];
  const networkOk = /* @__PURE__ */ new Map();
  const touch = (s) => {
    if (!contacted.includes(s)) contacted.push(s);
  };
  const fail = (msg) => {
    throw new FetchError(msg, contacted, problems);
  };
  async function withRetry(server, f) {
    let last;
    for (let i = 0; i <= retries; i++) {
      touch(server);
      try {
        return await f();
      } catch (e) {
        last = e;
        if (/http status 404|grpc status/.test(String(e.message))) break;
      }
    }
    throw last;
  }
  async function checkNetwork(server) {
    if (isExplorer(server)) return true;
    if (networkOk.has(server)) return networkOk.get(server);
    try {
      const info = decodeLightdInfo(await withRetry(server, () => unary(server, "GetLightdInfo", Buffer.alloc(0), call)));
      const ok = info.chainName === opts.network;
      if (!ok) problems.push({ server, error: `serves the "${info.chainName}" network, not "${opts.network}"` });
      networkOk.set(server, ok);
      return ok;
    } catch (e) {
      problems.push({ server, error: e.message });
      networkOk.set(server, false);
      return false;
    }
  }
  const heightOf = /* @__PURE__ */ new Map();
  const wanted = [...txidsIn];
  for (const h of heights) {
    const lists = [];
    const ops = /* @__PURE__ */ new Set();
    for (const server of servers) {
      if (lists.length >= need) break;
      if (ops.has(operatorOf(server))) continue;
      if (isExplorer(server) && lists.length === 0) continue;
      if (!isExplorer(server) && !await checkNetwork(server)) continue;
      try {
        const b = isExplorer(server) ? await withRetry(server, () => explorerGetBlock(server.slice(EXPLORER_PREFIX.length), h, call)) : decodeCompactBlock(await withRetry(server, () => unary(server, "GetBlock", encodeBlockId(h), call)));
        if (b.height !== h || b.txids.length === 0) throw new Error(`block ${h} not returned`);
        lists.push({ server, key: `${b.hash}:${b.txids.join(",")}`, txids: b.txids });
        ops.add(operatorOf(server));
      } catch (e) {
        problems.push({ server, error: `block ${h}: ${e.message}` });
      }
    }
    if (lists.length < need) fail(`could not get block ${h} from ${need} independent servers`);
    if (lists.some((l) => l.key !== lists[0].key)) fail(`servers disagree about block ${h}: ${lists.map((l) => l.server).join(" vs ")}`);
    for (const t of lists[0].txids) {
      heightOf.set(t, h);
      if (!wanted.includes(t)) wanted.push(t);
    }
  }
  const copies = /* @__PURE__ */ new Map();
  for (const t of wanted) copies.set(t, []);
  const missing = () => wanted.filter((t) => copies.get(t).length < need);
  for (const server of servers) {
    const todo = missing().filter((t) => !copies.get(t).some((c) => operatorOf(c.server) === operatorOf(server)));
    if (todo.length === 0) {
      if (missing().length === 0) break;
      continue;
    }
    if (!await checkNetwork(server)) continue;
    for (const t of todo) {
      let hex;
      let height;
      try {
        if (isExplorer(server)) {
          hex = (await withRetry(server, () => explorerGetTransaction(server.slice(EXPLORER_PREFIX.length), t, call))).hex;
        } else {
          const raw = decodeRawTransaction(await withRetry(server, () => unary(server, "GetTransaction", encodeTxFilter(t), call)));
          hex = raw.data.toString("hex");
          if (raw.height > 0n && raw.height < MAX_HEIGHT_SENTINEL - 1n) height = Number(raw.height);
        }
      } catch (e) {
        problems.push({ server, error: `${t}: ${e.message}` });
        continue;
      }
      const bad = checkTxBytes(hex, t);
      if (bad) {
        problems.push({ server, error: `${t}: ${bad}` });
        continue;
      }
      const list = copies.get(t);
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
  const transactions = wanted.map((t) => {
    const list = copies.get(t);
    const reported = list.map((c) => c.height).filter((x) => x !== void 0);
    let height = reported.length > 0 && reported.every((x) => x === reported[0]) ? reported[0] : void 0;
    const fromBlock = heightOf.get(t);
    if (fromBlock !== void 0 && height !== void 0 && height !== fromBlock) height = void 0;
    if (fromBlock !== void 0 && height === void 0 && reported.length === 0) height = fromBlock;
    return { txid: t, hex: list[0].hex, height, server: list[0].server, confirmedBy: list.map((c) => c.server) };
  });
  return { transactions, serversContacted: contacted, problems };
}

// src/relay/block-api.ts
async function describeBlock(server, height, timeoutMs = 15e3) {
  const b = server.startsWith(EXPLORER_PREFIX) ? await explorerGetBlock(server.slice(EXPLORER_PREFIX.length), height, { timeoutMs }) : decodeCompactBlock(await unary(server, "GetBlock", encodeBlockId(height), { timeoutMs }));
  return { server, hash: b.hash, txCount: b.txids.length, digest: createHash("sha256").update(b.txids.join(",")).digest("hex").slice(0, 16) };
}
async function blockReply(network, height, fetcher = fetchTransactions, describe = describeBlock) {
  const early = /* @__PURE__ */ new Map();
  const ask = (s) => early.has(s) ? early.get(s) : (early.set(s, describe(s, height)), early.get(s));
  const usual = [];
  for (const s of DEFAULT_SERVERS[network]) if (!usual.some((u) => operatorOf(u) === operatorOf(s))) usual.push(s);
  const head = usual.slice(0, 2).map((s) => ask(s).catch(() => null));
  const res = await fetcher({ network, heights: [height] });
  const txs = res.transactions.map((t) => ({ txid: t.txid, txHex: t.hex }));
  const picked = [];
  for (const s of res.serversContacted) if (!picked.some((p) => operatorOf(p) === operatorOf(s))) picked.push(s);
  const answers = await Promise.all(picked.slice(0, 2).map((s) => ask(s)));
  await Promise.all(head);
  const agree = answers.length === 2 && answers[0].digest === answers[1].digest && answers[0].hash === answers[1].hash;
  return { height, txs, answers, agree, serversContacted: res.serversContacted };
}
var MAX_AT_ONCE = 8;
var active = 0;
var waiting = [];
async function limited(job) {
  if (active >= MAX_AT_ONCE) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
var CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
var realBlock = (n, h) => limited(() => blockReply(n, h));
function answerBlock(req, res, block = realBlock) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/block") return false;
  const send = (code, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(body);
    return true;
  };
  if (req.method !== "GET") return send(405, "Only GET");
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return send(403, "Not allowed");
  const network = url.searchParams.get("network");
  const height = Number(url.searchParams.get("height"));
  if (network !== "main" && network !== "test" || !Number.isSafeInteger(height) || height < 1) return send(400, "Bad request");
  if ([...url.searchParams.keys()].some((k) => k !== "network" && k !== "height")) return send(400, "Bad request");
  return block(network, height).then(
    (r) => send(200, JSON.stringify(r), "application/json"),
    (e) => send(502, JSON.stringify({ error: e.message.slice(0, 300), serversContacted: e instanceof FetchError ? e.serversContacted : [] }), "application/json")
  );
}
function blockApi(block = realBlock) {
  return async (req, res) => {
    if (!await answerBlock(req, res, block)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Not found");
    }
  };
}

// src/relay/vercel.ts
var vercel_default = blockApi();
export {
  vercel_default as default
};
