// Locked answers for settle --fetch before the refund deadline. Written before the first run.
// The lot is the real test-network round (examples/testnet-01): open 4489077, close 4489085, refunds due by
// 4489110, refunds paid in blocks 4489096 and 4489100. Two fake light servers serve its blocks, and only up to
// the newest block they report.
//   newest block 4489090 (after the close, before the refunds): settle reads 4489077 to 4489090 and never asks
//   for a later block, lists the 3 refunds owed, writes both files, says which blocks it read and that refunds
//   due later are not covered, fails scan-blocks-read and refunds-paid, and exits 1. Never PASS.
//   the two servers report 4489095 and 4489090 as their newest block: the lower one is used.
//   newest block exactly 4489110 (the deadline): the whole range is read, no early note, PASS, exit 0.
//   newest block 4489080 (before the close): refused with exit 2, nothing written, no block asked for.
//   earlyRange: the same three cases as a pure function.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runAsync } from "../src/cli.ts";
import { earlyRange } from "../src/seller-kit.ts";
import { decodeMessage, fieldBytes, fieldVarint } from "../src/fetch/grpc.ts";

const rd = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const disc = rd("examples/testnet-01/disclosure.json");
const chain = rd("examples/testnet-01/chain.json");
const vec = rd("test/vectors/auction-round.json");
const ADDRESS: string = vec.parties["lot LOT-01"].address;
const OPEN = disc.openHeight as number;
const CLOSE = disc.closeHeight as number;
const REFUND_BY = disc.refundByHeight as number;

let tmp = "";
const closers: (() => void)[] = [];
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "imani-early-"));
  writeFileSync(join(tmp, "key.txt"), disc.ufvk + "\n");
});
after(() => {
  closers.forEach((c) => c());
  rmSync(tmp, { recursive: true, force: true });
});

const blocks = new Map<number, { txid: string; txHex: string }[]>(chain.blocks.map((b: any) => [b.height, b.txs]));
const txidToBytes = (t: string) => Buffer.from(t, "hex").reverse();
const bytesToTxid = (b: Buffer) => Buffer.from(b).reverse().toString("hex");

/** A light server for the test network whose newest block is `tip`: it has no block above it. */
async function fakeNode(tip: number) {
  const asked: number[] = [];
  const where = new Map<string, { hex: string; height: number }>();
  for (const [h, txs] of blocks) if (h <= tip) for (const t of txs) where.set(t.txid, { hex: t.txHex, height: h });
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
      if (method === "GetLightdInfo") reply = Buffer.concat([fieldBytes(1, Buffer.from("v0-test")), fieldBytes(4, Buffer.from("test")), fieldVarint(7, BigInt(tip))]);
      else if (method === "GetTransaction") {
        const t = where.get(bytesToTxid(msg.find((f) => f.field === 3)!.bytes!));
        if (!t) status = "5";
        else reply = Buffer.concat([fieldBytes(1, Buffer.from(t.hex, "hex")), fieldVarint(2, BigInt(t.height))]);
      } else if (method === "GetBlock") {
        const h = Number(msg.find((f) => f.field === 1)?.varint ?? 0n);
        asked.push(h);
        if (h > tip || !blocks.has(h)) status = "5";
        else {
          const ids = blocks.get(h)!.map((t) => t.txid);
          reply = Buffer.concat([fieldVarint(2, BigInt(h)), fieldBytes(3, Buffer.alloc(32, 7)), ...ids.map((t, i) => fieldBytes(7, Buffer.concat([fieldVarint(1, BigInt(i)), fieldBytes(2, txidToBytes(t))])))]);
        }
      } else status = "12";
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": status }));
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

function newLot(name: string): string {
  const f = join(tmp, name);
  const r = run([
    "lot-new", "--lot", disc.lotId, "--address", ADDRESS, "--key-file", join(tmp, "key.txt"), "--items", "2", "--reserve-zat", "1000000",
    "--open-height", String(OPEN), "--close-height", String(CLOSE), "--refund-by-height", String(REFUND_BY), "--out", f,
  ]);
  assert.equal(r.code, 0, r.stderr);
  return f;
}

const settleFetch = (folder: string, servers: string[]) => runAsync(["settle", "--folder", folder, "--fetch", "--server", servers.join(","), "--concurrency", "4"]);

test("the test round's heights are the ones the locked answers name", () => {
  assert.deepEqual([OPEN, CLOSE, REFUND_BY], [4489077, 4489085, 4489110]);
  const refundHeights = disc.transactions.filter((t: any) => t.height > CLOSE).map((t: any) => t.height);
  assert.ok(refundHeights.every((h: number) => h > 4489090 && h <= REFUND_BY));
});

test("settle --fetch before the refund deadline reads up to the newest block, lists the refunds and does not pass", async () => {
  const f = newLot("lot-early");
  // The two servers disagree on the newest block: the lower one, which both have, is used.
  const a = await fakeNode(4489095);
  const b = await fakeNode(4489090);
  const r = await settleFetch(f, [a.url, b.url]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(Math.max(...a.asked, ...b.asked) <= 4489090, "asked for a block that does not exist yet");
  assert.equal(Math.min(...a.asked, ...b.asked), OPEN);
  assert.match(r.stdout, /Read blocks 4489077 to 4489090, the newest block now\. The refund deadline is block 4489110, so blocks 4489091 to 4489110 were not read yet\./);
  assert.match(r.stdout, /Refunds paid after block 4489090 are not covered by this run/);
  assert.match(r.stdout, /Refunds owed \(3\)/);
  assert.match(r.stdout, /Not ready to publish: this run stopped at block 4489090, before the refund deadline 4489110\./);
  assert.match(r.stdout, /RESULT: FAIL/);
  assert.doesNotMatch(r.stdout, /RESULT: PASS/);
  assert.match(r.stdout, /scan-blocks-read/);
  assert.match(r.stdout, /refunds-paid/);
  assert.match(r.stdout, /Blocks missing: 4489091 to 4489110\./);
  const out = JSON.parse(readFileSync(join(f, "settled", "result.json"), "utf8"));
  assert.equal(out.refunds.length, 3);
  // The written disclosure still names the real deadline, so a checker reads the whole window.
  const d = JSON.parse(readFileSync(join(f, "settled", "disclosure.json"), "utf8"));
  assert.equal(d.refundByHeight, REFUND_BY);
});

test("settle --fetch at the refund deadline reads the whole range and passes", async () => {
  const f = newLot("lot-at-deadline");
  const a = await fakeNode(REFUND_BY);
  const b = await fakeNode(REFUND_BY);
  const r = await settleFetch(f, [a.url, b.url]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(Math.max(...a.asked, ...b.asked), REFUND_BY);
  assert.doesNotMatch(r.stdout, /not covered|Not ready to publish/);
  assert.match(r.stdout, /RESULT: PASS/);
});

test("settle --fetch before the close is refused and writes nothing", async () => {
  const f = newLot("lot-open");
  const a = await fakeNode(4489080);
  const b = await fakeNode(4489080);
  const r = await settleFetch(f, [a.url, b.url]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the lot has not closed yet\. The newest block is 4489080 and bids count up to block 4489085\./);
  assert.deepEqual([...a.asked, ...b.asked], []);
  assert.equal(existsSync(join(f, "settled")), false);
});

test("earlyRange reads the whole range after the deadline, stops at the newest block before it, and refuses before the close", () => {
  const range = { from: 100, to: 140, closeHeight: 120 };
  assert.deepEqual(earlyRange(range, 140), { to: 140, missing: [] });
  assert.deepEqual(earlyRange(range, 500), { to: 140, missing: [] });
  assert.deepEqual(earlyRange(range, 137), { to: 137, missing: [138, 139, 140] });
  assert.deepEqual(earlyRange(range, 120), { to: 120, missing: Array.from({ length: 20 }, (_, i) => 121 + i) });
  assert.throws(() => earlyRange(range, 119), /not closed yet/);
});
