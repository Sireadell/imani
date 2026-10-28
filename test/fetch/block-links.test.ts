// Block link check: each downloaded block must name the block before it. Fake local servers only;
// nothing here touches the network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fetchTransactions } from "../../src/fetch/index.ts";
import { checkBlockLinks } from "../../src/fetch/links.ts";
import { fetchBlocks } from "../../src/scan/fetch-blocks.ts";
import { fieldBytes, fieldVarint, decodeMessage, txidToBytes } from "../../src/fetch/grpc.ts";

const vectors = JSON.parse(readFileSync(new URL("../vectors/offline-vectors.json", import.meta.url), "utf8"));
const A = vectors.cases.orchard_v5_payment as { txid: string; txHex: string };
const B = vectors.cases.ironwood_v6_payment as { txid: string; txHex: string };
const C = vectors.cases.orchard_nu6_2_payment as { txid: string; txHex: string };
const txs: Record<string, string> = { [A.txid]: A.txHex, [B.txid]: B.txHex, [C.txid]: C.txHex };
const H = 4200000;
const ids = [A.txid, B.txid, C.txid];

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** Block h holds ids[h - H]. Its hash is 32 bytes of (h - H + 10); `prev` says what it claims comes before it. */
async function fakeServer(prev: (h: number) => number | null = (h) => h - H + 9) {
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
      const msg = decodeMessage(Buffer.concat(chunks).subarray(5));
      const method = String(headers[":path"]).split("/").pop();
      let reply: Buffer | null = null;
      let status = "0";
      if (method === "GetLightdInfo") reply = Buffer.concat([fieldBytes(4, Buffer.from("test")), fieldVarint(7, BigInt(H + 100))]);
      else if (method === "GetTransaction") {
        const t = msg.find((f) => f.field === 3)?.bytes;
        const id = t ? Buffer.from(t).reverse().toString("hex") : "";
        if (!txs[id]) status = "5";
        else reply = Buffer.concat([fieldBytes(1, Buffer.from(txs[id], "hex")), fieldVarint(2, BigInt(H + ids.indexOf(id)))]);
      } else if (method === "GetBlock") {
        const h = Number(msg.find((f) => f.field === 1)?.varint ?? 0n);
        const id = ids[h - H];
        if (!id) status = "5";
        else {
          const p = prev(h);
          reply = Buffer.concat([
            fieldVarint(2, BigInt(h)),
            fieldBytes(3, Buffer.alloc(32, h - H + 10)),
            ...(p === null ? [] : [fieldBytes(4, Buffer.alloc(32, p))]),
            fieldBytes(7, Buffer.concat([fieldVarint(1, 0n), fieldBytes(2, txidToBytes(id))])),
          ]);
        }
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const pair = async (prev?: (h: number) => number | null) => [await fakeServer(prev), (await fakeServer(prev)).replace("127.0.0.1", "localhost")];

test("a block whose previous hash does not match the block before it is refused, naming the height", async () => {
  const servers = await pair((h) => (h === H + 1 ? 99 : h - H + 9));
  await assert.rejects(fetchTransactions({ network: "test", heights: [H, H + 1], servers }), /block 4200001 does not link to block 4200000/);
});

test("the same refusal holds when blocks are downloaded one at a time (the scan path)", async () => {
  const servers = await pair((h) => (h === H + 2 ? 99 : h - H + 9));
  await assert.rejects(fetchBlocks({ network: "test", from: H, to: H + 2, servers, retries: 0 }), /block 4200002 does not link to block 4200001/);
});

test("a range whose blocks link passes, one call or one block at a time", async () => {
  const servers = await pair();
  const r = await fetchTransactions({ network: "test", heights: [H, H + 1, H + 2], servers });
  assert.equal(r.transactions.length, 3);
  assert.deepEqual(r.blockLinks?.map((b) => b.height), [H, H + 1, H + 2]);
  const f = await fetchBlocks({ network: "test", from: H, to: H + 2, servers, retries: 0 });
  assert.deepEqual(f.blocks.map((b) => b.txs.map((t) => t.txid)), [[A.txid], [B.txid], [C.txid]]);
});

test("a range with a gap is handled as before: the blocks on either side of the gap are not compared", async () => {
  const servers = await pair((h) => (h === H + 2 ? 99 : h - H + 9));
  const r = await fetchTransactions({ network: "test", heights: [H, H + 2], servers });
  assert.equal(r.transactions.length, 2);
});

test("servers that send no previous hash are not refused (nothing to compare)", async () => {
  const servers = await pair(() => null);
  const r = await fetchTransactions({ network: "test", heights: [H, H + 1], servers });
  assert.equal(r.transactions.length, 2);
});

test("checkBlockLinks on plain lists", () => {
  assert.equal(checkBlockLinks([{ height: 5, hash: "a" }, { height: 6, hash: "b", prevHash: "a" }]), null);
  assert.equal(checkBlockLinks([{ height: 5, hash: "a" }, { height: 7, hash: "b", prevHash: "zz" }]), null);
  assert.match(checkBlockLinks([{ height: 6, hash: "b", prevHash: "x" }, { height: 5, hash: "a" }])!, /block 6 does not link to block 5/);
});

test("saved rounds still check PASS", () => {
  for (const dir of ["testnet-01", "mainnet-01"]) {
    const base = new URL(`../../examples/${dir}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const r = spawnSync(process.execPath, ["bin/imani.js", "check", "--scan", "--chain", `${base}chain.json`, "--disclosure", `${base}disclosure.json`, "--result", `${base}result.json`], { encoding: "utf8" });
    assert.equal(r.status, 0, `${dir}: ${r.stdout.slice(-300)}${r.stderr.slice(-300)}`);
  }
});
