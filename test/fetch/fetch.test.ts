// Fetch helper tests. They run without network: fake light servers (gRPC over node:http2),
// a fake explorer (node:http) and a fake SOCKS5 proxy all listen on 127.0.0.1.
// The one live test at the bottom runs only with LIVE=1.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fetchTransactions, FetchError, operatorOf } from "../../src/fetch/index.ts";
import { fieldBytes, fieldVarint, decodeMessage, bytesToTxid, txidToBytes } from "../../src/fetch/grpc.ts";
import { computeTxid, checkTxBytes } from "../../src/fetch/verify.ts";
import { main as cliMain } from "../../src/fetch/cli.ts";

const vectors = JSON.parse(readFileSync(new URL("../vectors/offline-vectors.json", import.meta.url), "utf8"));
const A = vectors.cases.orchard_v5_payment as { txid: string; txHex: string };
const B = vectors.cases.ironwood_v6_payment as { txid: string; txHex: string };
const C = vectors.cases.orchard_nu6_2_payment as { txid: string; txHex: string };
const HEIGHT = 4200000;

/** Same transaction, one byte of the transparent signature changed: the txid stays the same. */
function resigned(hex: string): string {
  const p = hex.indexOf("6a473044022") + 20;
  return hex.slice(0, p) + (hex[p] === "0" ? "1" : "0") + hex.slice(p + 1);
}

type Behaviour = {
  chain?: string;
  txs?: Record<string, string>; // txid -> hex served
  blocks?: Record<number, string[]>; // height -> txids
  hang?: boolean;
  failFirst?: number;
};

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** A fake light wallet server. Records every request body it receives. */
async function fakeLightServer(b: Behaviour) {
  const seen: { path: string; body: Buffer }[] = [];
  let failures = b.failFirst ?? 0;
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    stream.on("error", () => {});
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = String(headers[":path"]);
      seen.push({ path, body });
      if (b.hang) return; // never answers
      if (failures > 0) {
        failures--;
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      const msg = decodeMessage(body.subarray(5));
      let reply: Buffer | null = null;
      let status = "0";
      const method = path.split("/").pop();
      if (method === "GetLightdInfo") {
        reply = Buffer.concat([
          fieldBytes(1, Buffer.from("v0.0.0-test")),
          fieldBytes(4, Buffer.from(b.chain ?? "test")),
          fieldVarint(7, BigInt(HEIGHT + 100)),
        ]);
      } else if (method === "GetTransaction") {
        const hash = msg.find((f) => f.field === 3)?.bytes;
        const hex = hash ? b.txs?.[bytesToTxid(hash)] : undefined;
        if (hex === undefined) status = "5";
        else reply = Buffer.concat([fieldBytes(1, Buffer.from(hex, "hex")), fieldVarint(2, BigInt(HEIGHT))]);
      } else if (method === "GetBlock") {
        const h = Number(msg.find((f) => f.field === 1)?.varint ?? 0n);
        const ids = b.blocks?.[h];
        if (!ids) status = "5";
        else
          reply = Buffer.concat([
            fieldVarint(2, BigInt(h)),
            fieldBytes(3, Buffer.alloc(32, 7)),
            ...ids.map((t, i) => fieldBytes(7, Buffer.concat([fieldVarint(1, BigInt(i)), fieldBytes(2, txidToBytes(t))]))),
          ]);
      } else status = "12";
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": status, ...(status === "0" ? {} : { "grpc-message": "not found" }) }));
      if (reply) {
        const frame = Buffer.alloc(5);
        frame.writeUInt32BE(reply.length, 1);
        stream.end(Buffer.concat([frame, reply]));
      } else stream.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    for (const s of sessions) s.destroy();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen };
}

async function fakeExplorer(txs: Record<string, string>, blocks: Record<number, string[]> = {}) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const blk = /^\/api\/block\/(\d+)$/.exec(req.url ?? "");
    if (blk) {
      const ids = blocks[Number(blk[1])];
      res.writeHead(ids ? 200 : 404, { "content-type": "application/json" });
      // The same hash the fake light server sends (32 bytes of 7), in display order.
      res.end(JSON.stringify(ids ? { height: blk[1], hash: "07".repeat(32), transactions: ids.map((txid) => ({ txid })) } : { error: "Block not found" }));
      return;
    }
    const m = /^\/api\/tx\/([0-9a-f]{64})\/raw$/.exec(req.url ?? "");
    const hex = m ? txs[m[1]] : undefined;
    res.writeHead(hex ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(hex ? { txid: m![1], hex } : { error: "Transaction not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `cipherscan:http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Minimal SOCKS5 proxy that records the host names it was asked to reach. */
async function fakeSocks() {
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    let stage = 0;
    let buf = Buffer.alloc(0);
    client.on("data", function onData(d: Buffer) {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString();
        const port = buf.readUInt16BE(5 + buf[4]);
        targets.push(`${host}:${port}`);
        client.off("data", onData);
        const up = net.connect(port, host === "localhost" ? "127.0.0.1" : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(up).pipe(client);
        });
        up.on("error", () => client.destroy());
        client.on("error", () => up.destroy());
        stage = 2;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { url: `socks5h://127.0.0.1:${(server.address() as AddressInfo).port}`, targets };
}

const all = { [A.txid]: A.txHex, [B.txid]: B.txHex, [C.txid]: C.txHex };

test("txid check uses librustzcash and matches the generator's txids", () => {
  for (const c of Object.values<any>(vectors.cases)) assert.equal(computeTxid(c.txHex).txid, c.txid);
  assert.equal(checkTxBytes(A.txHex, A.txid), null);
  assert.match(checkTxBytes(B.txHex, A.txid)!, /different txid/);
  assert.match(checkTxBytes(A.txHex + "00", A.txid)!, /extra bytes/);
  assert.match(checkTxBytes(A.txHex.slice(0, -2), A.txid)!, /could not read/);
  // A changed signature keeps the txid, which is why the two-server check exists.
  assert.equal(checkTxBytes(resigned(A.txHex), A.txid), null);
});

test("fetches by txid from two operators and reports exactly who was contacted", async () => {
  const s1 = await fakeLightServer({ txs: all });
  const s2 = await fakeLightServer({ txs: all });
  const s3 = await fakeLightServer({ txs: all });
  const r = await fetchTransactions({ network: "test", txids: [A.txid, B.txid], servers: [s1.url, s2.url, s3.url] });
  assert.deepEqual(r.transactions.map((t) => [t.txid, t.hex, t.height, t.server, t.confirmedBy]), [
    [A.txid, A.txHex, HEIGHT, s1.url, [s1.url, s2.url]],
    [B.txid, B.txHex, HEIGHT, s1.url, [s1.url, s2.url]],
  ]);
  assert.deepEqual(r.serversContacted, [s1.url, s2.url]);
  assert.equal(s3.seen.length, 0, "third server never contacted");
});

test("requests carry only txids and heights, never a key", async () => {
  const s1 = await fakeLightServer({ txs: all, blocks: { [HEIGHT]: [A.txid, C.txid] } });
  const s2 = await fakeLightServer({ txs: all, blocks: { [HEIGHT]: [A.txid, C.txid] } });
  await fetchTransactions({ network: "test", txids: [B.txid], heights: [HEIGHT], servers: [s1.url, s2.url] });
  const keys = Object.values<any>(vectors.parties).map((p) => p.ufvk as string);
  for (const { path, body } of [...s1.seen, ...s2.seen]) {
    const text = body.toString("latin1");
    assert.ok(!/uview|zxview|secret-extended|seed/i.test(text), `no key-like text sent to ${path}`);
    for (const k of keys) assert.ok(!text.includes(k.slice(0, 20)));
    assert.ok(body.length <= 5 + 2 + 32, `request is at most one txid long (${body.length} bytes)`);
  }
});

test("servers that return different bytes for the same txid make the fetch fail", async () => {
  const s1 = await fakeLightServer({ txs: all });
  const s2 = await fakeLightServer({ txs: { ...all, [A.txid]: resigned(A.txHex) } });
  await assert.rejects(
    fetchTransactions({ network: "test", txids: [A.txid], servers: [s1.url, s2.url] }),
    (e: unknown) => e instanceof FetchError && /different bytes/.test(e.message) && e.serversContacted.length === 2,
  );
});

test("wrong or padded bytes are rejected and the next server is tried", async () => {
  const liar = await fakeLightServer({ txs: { [A.txid]: B.txHex } });
  const padder = await fakeLightServer({ txs: { [A.txid]: A.txHex + "deadbeef" } });
  const s1 = await fakeLightServer({ txs: all });
  const s2 = await fakeLightServer({ txs: all });
  const r = await fetchTransactions({ network: "test", txids: [A.txid], servers: [liar.url, padder.url, s1.url, s2.url] });
  assert.deepEqual(r.transactions[0].confirmedBy, [s1.url, s2.url]);
  assert.equal(r.transactions[0].hex, A.txHex);
  assert.match(r.problems.map((p) => p.error).join("\n"), /different txid/);
  assert.match(r.problems.map((p) => p.error).join("\n"), /extra bytes/);
});

test("one server is not enough unless cross-checking is turned off", async () => {
  const s1 = await fakeLightServer({ txs: all });
  await assert.rejects(fetchTransactions({ network: "test", txids: [A.txid], servers: [s1.url] }), /two servers run by different operators/);
  const r = await fetchTransactions({ network: "test", txids: [A.txid], servers: [s1.url], crossCheck: false });
  assert.equal(r.transactions[0].hex, A.txHex);
});

test("two addresses of the same operator do not count as a cross-check", () => {
  assert.equal(operatorOf("https://na.zec.rocks:443"), operatorOf("https://eu.zec.rocks:443"));
  assert.notEqual(operatorOf("https://zec.rocks:443"), operatorOf("https://zec-node.cakewallet.com:443"));
  assert.equal(operatorOf("cipherscan:https://api.testnet.cipherscan.app"), "cipherscan.app");
});

test("a server on the wrong network is skipped", async () => {
  const mainnet = await fakeLightServer({ chain: "main", txs: all });
  const s1 = await fakeLightServer({ txs: all });
  const s2 = await fakeLightServer({ txs: all });
  const r = await fetchTransactions({ network: "test", txids: [A.txid], servers: [mainnet.url, s1.url, s2.url] });
  assert.equal(mainnet.seen.length, 1, "only asked which network it serves");
  assert.match(r.problems[0].error, /serves the "main" network/);
});

test("a silent server times out and a flaky one is retried", async () => {
  const silent = await fakeLightServer({ hang: true });
  const flaky = await fakeLightServer({ txs: all, failFirst: 1 });
  const s2 = await fakeLightServer({ txs: all });
  const r = await fetchTransactions({ network: "test", txids: [A.txid], servers: [silent.url, flaky.url, s2.url], timeoutMs: 500 });
  assert.deepEqual(r.transactions[0].confirmedBy, [flaky.url, s2.url]);
  assert.match(r.problems[0].error, /timeout/);
});

test("fetching by height returns every transaction in the block", async () => {
  const blocks = { [HEIGHT]: [A.txid, B.txid, C.txid] };
  const s1 = await fakeLightServer({ txs: all, blocks });
  const s2 = await fakeLightServer({ txs: all, blocks });
  const r = await fetchTransactions({ network: "test", heights: [HEIGHT], servers: [s1.url, s2.url] });
  assert.deepEqual(r.transactions.map((t) => t.txid), [A.txid, B.txid, C.txid]);
  assert.ok(r.transactions.every((t) => t.height === HEIGHT));
});

test("servers that disagree about a block's contents make the fetch fail", async () => {
  const s1 = await fakeLightServer({ txs: all, blocks: { [HEIGHT]: [A.txid, B.txid] } });
  const s2 = await fakeLightServer({ txs: all, blocks: { [HEIGHT]: [A.txid] } });
  await assert.rejects(fetchTransactions({ network: "test", heights: [HEIGHT], servers: [s1.url, s2.url] }), /disagree about block/);
});

test("explorer route works as the second source", async () => {
  const s1 = await fakeLightServer({ txs: all });
  const ex = await fakeExplorer(all);
  const r = await fetchTransactions({ network: "test", txids: [C.txid], servers: [s1.url, ex.url] });
  assert.deepEqual(r.transactions[0].confirmedBy, [s1.url, ex.url]);
  assert.deepEqual(ex.seen, [`/api/tx/${C.txid}/raw`]);
});

test("an explorer can be the second source for a block, but never the only one", async () => {
  const blocks = { [HEIGHT]: [A.txid, B.txid, C.txid] };
  const s1 = await fakeLightServer({ txs: all, blocks });
  const ex = await fakeExplorer(all, blocks);
  const r = await fetchTransactions({ network: "test", heights: [HEIGHT], servers: [s1.url, ex.url] });
  assert.deepEqual(r.transactions.map((t) => t.txid), [A.txid, B.txid, C.txid]);
  assert.ok(ex.seen.includes(`/api/block/${HEIGHT}`));
  const bad = await fakeExplorer(all, { [HEIGHT]: [A.txid, B.txid] });
  await assert.rejects(fetchTransactions({ network: "test", heights: [HEIGHT], servers: [s1.url, bad.url] }), /disagree about block/);
  const alone = await fakeExplorer(all, blocks);
  await assert.rejects(fetchTransactions({ network: "test", heights: [HEIGHT], servers: [alone.url] }), /could not get block/);
  assert.equal(alone.seen.filter((u) => u.startsWith("/api/block/")).length, 0);
});

test("all connections can go through a SOCKS5 proxy, with host names resolved by the proxy", async () => {
  const s1 = await fakeLightServer({ txs: all });
  const ex = await fakeExplorer(all);
  const proxy = await fakeSocks();
  const lightUrl = s1.url.replace("127.0.0.1", "localhost");
  const exUrl = ex.url.replace("127.0.0.1", "localhost");
  const r = await fetchTransactions({ network: "test", txids: [A.txid], servers: [lightUrl, exUrl], proxy: proxy.url });
  assert.equal(r.transactions[0].hex, A.txHex);
  assert.ok(proxy.targets.length >= 2 && proxy.targets.every((t) => t.startsWith("localhost:")));
});

test("bad input is refused before any connection", async () => {
  const s1 = await fakeLightServer({ txs: all });
  await assert.rejects(fetchTransactions({ network: "test", txids: ["uviewtest1abc"], servers: [s1.url] }), /not a txid/);
  await assert.rejects(fetchTransactions({ network: "test", heights: [-1], servers: [s1.url] }), /not a block height/);
  await assert.rejects(fetchTransactions({ network: "test", txids: [A.txid], servers: ["ftp://x"] }), /https:\/\/ or http:\/\//);
  assert.equal(s1.seen.length, 0);
});

test("standalone script prints the servers it contacted", async () => {
  const s1 = await fakeLightServer({ txs: all });
  const s2 = await fakeLightServer({ txs: all });
  const lines: string[] = [];
  const code = await cliMain(["--network", "test", "--txid", A.txid, "--server", s1.url, "--server", s2.url], (l) => lines.push(l), (l) => lines.push(l));
  assert.equal(code, 0);
  assert.equal(lines.at(-1), `servers contacted: ${s1.url}, ${s2.url}`);
});

// ---- optional live test: LIVE=1 npm run test:fetch ----
// Mainnet block 3,509,784 (October 2026), fetched from the default public servers.
test("live: mainnet transaction from two public operators", { skip: process.env.LIVE !== "1" && "set LIVE=1 to run" }, async () => {
  const txid = "43183164da02c73aaff753c431dd815169b64f72c78cfd4249d39ed08bfa6279";
  const r = await fetchTransactions({ network: "main", txids: [txid] });
  assert.equal(r.transactions[0].txid, txid);
  assert.equal(r.transactions[0].height, 3509784);
  assert.equal(r.transactions[0].confirmedBy.length, 2);
  console.log(`servers contacted: ${r.serversContacted.join(", ")}`);
});
