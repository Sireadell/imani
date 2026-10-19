import { test, after } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLot } from "../../src/check.ts";
import { run, runAsync } from "../../src/cli.ts";
import { blocksInRange, type ChainFile } from "../../src/scan/chain.ts";
import { scanRange, heightRuns, type ScanInput } from "../../src/scan/scan.ts";
import { fetchBlocks, BlockFetchError } from "../../src/scan/fetch-blocks.ts";
import { decodeMessage, fieldBytes, fieldVarint } from "../../src/fetch/grpc.ts";

const ex = (p: string) => new URL(`../../examples/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(ex(p), "utf8"));
const path = (p: string) => fileURLToPath(ex(p));
const load = (dir: string) => ({ d: json(`${dir}/disclosure.json`), r: json(`${dir}/result.json`), chain: json(`${dir}/chain.json`) as ChainFile });

function scanInput(d: any, chain: ChainFile, extra: Partial<ScanInput> = {}): ScanInput {
  const range = scanRange(d, 10);
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  return {
    blocks,
    missing,
    graceBlocks: 10,
    source: { kind: "chain-file", label: "test chain", serversContacted: [], bytes: 0, ms: 0 },
    ...extra,
  };
}
const cli = (dir: string, ...extra: string[]) =>
  run(["check", "--disclosure", path(`${dir}/disclosure.json`), "--result", path(`${dir}/result.json`), "--scan", "--chain", path(`${dir}/chain.json`), ...extra]);

const honest = load("scan-01");
const KEY = honest.d.ufvk as string;

test("scan-01: the honest lot passes all three levels, offline", () => {
  const v = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, honest.chain) });
  assert.equal(v.result, "PASS");
  assert.equal(v.scanLevel, "PASS");
  assert.equal(v.checks.filter((c) => c.level === 3).length, 5);
  assert.equal(v.checks.length, 20);
  assert.deepEqual(v.serversContacted, []);
  assert.deepEqual([v.scanRange!.from, v.scanRange!.to], [4200005, 4200125]);
  const res = cli("scan-01");
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Servers contacted: none/);
  assert.match(res.stdout, /\[scan level\] Every block in the lot's range was read\. Read all 121 blocks/);
  assert.match(res.stdout, /RESULT: PASS \(20 of 20 checks passed\)/);
});

test("without --scan the checker is unchanged: 15 checks, no scan level", () => {
  const v = checkLot(honest.d, honest.r);
  assert.equal(v.checks.length, 15);
  assert.equal(v.scanLevel, "not run");
});

const manifest = json("scan-broken/manifest.json");
test("there are three broken scan copies", () => assert.equal(manifest.copies.length, 3));
for (const copy of manifest.copies) {
  test(`scan copy ${copy.name} fails on ${copy.expectedFailingCheck} only, and the key level alone passes`, () => {
    const { d, r, chain } = load(`scan-broken/${copy.name}`);
    assert.equal(checkLot(d, r).result, "PASS", "the key level alone is fooled");
    const v = checkLot(d, r, { scan: scanInput(d, chain) });
    assert.deepEqual(v.failed, [copy.expectedFailingCheck]);
    const res = cli(`scan-broken/${copy.name}`);
    assert.equal(res.code, 1);
    assert.match(res.stdout, new RegExp(`RESULT: FAIL \\(1 of 20 checks failed: ${copy.expectedFailingCheck}\\)`));
  });
}

test("the named reasons say what was found", () => {
  const reason = (name: string, id: string) => {
    const { d, r, chain } = load(`scan-broken/${name}`);
    return checkLot(d, r, { scan: scanInput(d, chain) }).checks.find((c) => c.id === id)!.reason;
  };
  assert.match(reason("01-hidden-bid", "scan-hidden-bids"), /^hidden bid: 4585c1c8f3 at block 4200060, 3,000,000 zat/);
  assert.match(reason("02-listed-not-in-range", "scan-listed-in-range"), /^listed payment not in the range: 12260d9742/);
  assert.match(reason("03-wrong-height", "scan-heights"), /wrong height: ab867ef097, the seller says block 4200099, the chain shows block 4200105 \(on the other side of the close/);
});

test("a missing block fails the scan as incomplete", () => {
  const chain = structuredClone(honest.chain);
  chain.blocks = chain.blocks.filter((b) => b.height !== 4200040 && b.height !== 4200041);
  const v = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, chain) });
  assert.deepEqual(v.failed, ["scan-blocks-read"]);
  assert.match(v.checks.find((c) => c.id === "scan-blocks-read")!.reason, /Blocks missing: 4200040 to 4200041\./);
});

test("a block whose bytes are another transaction fails the scan", () => {
  const chain = structuredClone(honest.chain);
  const b = chain.blocks.find((x) => x.height === 4200010)!;
  b.txs[0].txid = "ab".repeat(32);
  const v = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, chain) });
  assert.ok(v.failed.includes("scan-blocks-read"));
});

test("an unlisted refund is reported on its own", () => {
  const d = structuredClone(honest.d);
  d.transactions = d.transactions.filter((t: any) => t.txid !== "56d790d794cd1fad135791529573af0e087ffaba2a0f3f12b32dfc13911798d1");
  const v = checkLot(d, honest.r, { scan: scanInput(d, honest.chain) });
  assert.ok(v.failed.includes("scan-unlisted-payments"));
  assert.match(v.checks.find((c) => c.id === "scan-unlisted-payments")!.reason, /^unlisted refund: 56d790d794/);
});

test("bidders' own keys prove their refunds arrived; a wrong key fails", () => {
  const keys = json("scan-01/bidder-keys.json").keys;
  const ok = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, honest.chain, { bidderKeys: keys }) });
  assert.equal(ok.result, "PASS");
  assert.equal(ok.checks.find((c) => c.id === "scan-refund-receivers")!.status, "PASS");
  // Carol's key given for Alice's bid: Carol's wallet never received Alice's refund.
  const swapped = [{ bidTxid: keys[0].bidTxid, ufvk: keys[2].ufvk }];
  const bad = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, honest.chain, { bidderKeys: swapped }) });
  assert.deepEqual(bad.failed, ["scan-refund-receivers"]);
  const res = cli("scan-01", "--bidder-keys", path("scan-01/bidder-keys.json"));
  assert.equal(res.code, 0);
  for (const k of keys) assert.ok(!res.stdout.includes(k.ufvk.slice(10, 40)), "a bidder key was printed");
});

test("without bidder keys the report says refund receivers are not proven", () => {
  const v = checkLot(honest.d, honest.r, { scan: scanInput(honest.d, honest.chain) });
  assert.match(v.scanNotes.join(" "), /Refund receivers are not proven/);
});

test("the scan range: open to refund deadline, at least the grace window past the close", () => {
  assert.deepEqual(scanRange({ openHeight: 10, closeHeight: 20, refundByHeight: 40 }, 10), {
    from: 10, to: 40, openHeight: 10, closeHeight: 20, refundByHeight: 40, graceBlocks: 10,
  });
  assert.equal(scanRange({ openHeight: 10, closeHeight: 20, refundByHeight: 22 }, 10).to, 30);
  assert.throws(() => scanRange({ closeHeight: 20, refundByHeight: 40 }), /openHeight/);
  assert.throws(() => scanRange({ openHeight: 10, closeHeight: 20 }), /refundByHeight/);
  assert.throws(() => scanRange({ openHeight: 30, closeHeight: 20, refundByHeight: 40 }), /after closeHeight/);
  assert.equal(heightRuns([1, 2, 3, 7, 9, 10]), "1 to 3, 7, 9 to 10");
});

test("CLI: the scan needs a block source; flags need --scan; errors say no server was contacted", () => {
  const base = ["check", "--disclosure", path("scan-01/disclosure.json"), "--result", path("scan-01/result.json")];
  for (const extra of [["--scan"], ["--chain", "x.json"], ["--scan", "--fetch", "--chain", "x.json"]]) {
    const res = run([...base, ...extra]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /Servers contacted: none/);
  }
  // round-01 has no openHeight: the scan refuses with a clear message.
  const res = run(["check", "--disclosure", path("round-01/disclosure.json"), "--result", path("round-01/result.json"), "--scan", "--chain", path("scan-01/chain.json")]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /openHeight/);
});

test("CLI --fetch refuses a bad key before opening any connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-scan-"));
  try {
    const d = { ...honest.d, ufvk: "secret-extended-key-test1qwerty" };
    writeFileSync(join(dir, "d.json"), JSON.stringify(d));
    const res = await runAsync(["check", "--disclosure", join(dir, "d.json"), "--result", path("scan-01/result.json"), "--scan", "--fetch"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /^Refused: /);
    assert.match(res.stderr, /Servers contacted: none$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report.html marks scan checks and stays self-contained", () => {
  const dir = mkdtempSync(join(tmpdir(), "imani-scan-"));
  try {
    cli("scan-broken/01-hidden-bid", "--out", dir);
    const html = readFileSync(join(dir, "report.html"), "utf8");
    assert.match(html, /Scan level \(reads every block in the lot's range with the lot key\)/);
    assert.match(html, /scan level<\/span>/);
    assert.match(html, /hidden bid: 4585c1c8f3/);
    assert.ok(!/<script/i.test(html) && !/(src|href)\s*=/i.test(html) && !/https?:\/\//i.test(html));
    assert.ok(!html.includes(KEY.slice(10, 40)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- live block download, against two fake light servers on 127.0.0.1 ----------

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));
const txidToBytes = (t: string) => Buffer.from(t, "hex").reverse();
const bytesToTxid = (b: Buffer) => Buffer.from(b).reverse().toString("hex");

/** Serves blocks (height -> txs) of the honest chain. Records every request body. */
async function fakeLightServer(blocks: Map<number, { txid: string; txHex: string }[]>, lie?: { height: number }) {
  const bodies: Buffer[] = [];
  const where = new Map<string, { hex: string; height: number }>();
  for (const [h, txs] of blocks) for (const t of txs) where.set(t.txid, { hex: t.txHex, height: h });
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
      bodies.push(body);
      const msg = decodeMessage(body.subarray(5));
      const method = String(headers[":path"]).split("/").pop();
      let reply: Buffer | null = null;
      let status = "0";
      if (method === "GetLightdInfo") reply = Buffer.concat([fieldBytes(1, Buffer.from("v0-test")), fieldBytes(4, Buffer.from("test")), fieldVarint(7, 4200200n)]);
      else if (method === "GetTransaction") {
        const t = where.get(bytesToTxid(msg.find((f) => f.field === 3)!.bytes!));
        if (!t) status = "5";
        else reply = Buffer.concat([fieldBytes(1, Buffer.from(t.hex, "hex")), fieldVarint(2, BigInt(t.height))]);
      } else if (method === "GetBlock") {
        const h = Number(msg.find((f) => f.field === 1)?.varint ?? 0n);
        const ids = (blocks.get(h) ?? []).map((t) => t.txid);
        const hash = Buffer.alloc(32, lie && lie.height === h ? 8 : 7); // a lying server reports another block
        if (!blocks.has(h)) status = "5";
        else reply = Buffer.concat([fieldVarint(2, BigInt(h)), fieldBytes(3, hash), ...ids.map((t, i) => fieldBytes(7, Buffer.concat([fieldVarint(1, BigInt(i)), fieldBytes(2, txidToBytes(t))])))]);
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const someBlocks = new Map(honest.chain.blocks.filter((b) => b.txs.length > 0 && b.height <= 4200030).map((b) => [b.height, b.txs]));

test("fetchBlocks downloads whole blocks from two servers, reports progress and sends no key", async () => {
  const a = await fakeLightServer(someBlocks);
  const b = await fakeLightServer(someBlocks);
  // Ask block by block over heights that all hold transactions (a real block always has one).
  const heights = [...someBlocks.keys()];
  const progress: number[] = [];
  const got = [];
  for (const h of heights) {
    const r = await fetchBlocks({ network: "test", from: h, to: h, servers: [a.url, b.url], concurrency: 2, groupSize: 1, onProgress: (done) => progress.push(done) });
    got.push(...r.blocks);
    assert.deepEqual(r.source.serversContacted, [a.url, b.url]);
    assert.equal(r.source.kind, "light-servers");
    assert.ok(r.source.bytes > 0);
  }
  assert.deepEqual(got.map((x) => x.height), heights);
  assert.deepEqual(got.map((x) => x.txs.map((t) => t.txid)), heights.map((h) => someBlocks.get(h)!.map((t) => t.txid)));
  assert.equal(progress.length, heights.length);
  for (const body of [...a.bodies, ...b.bodies]) {
    assert.ok(!body.toString("latin1").includes("uview"), "a key was sent");
  }
});

test("fetchBlocks fails, naming the servers, when two servers disagree about a block", async () => {
  const a = await fakeLightServer(someBlocks);
  const b = await fakeLightServer(someBlocks, { height: 4200007 });
  await assert.rejects(
    fetchBlocks({ network: "test", from: 4200007, to: 4200007, servers: [a.url, b.url] }),
    (e: unknown) => e instanceof BlockFetchError && /disagree/.test(e.message) && e.serversContacted.length === 2,
  );
});

// ---------- heights against what the light servers return ----------

test("--fetch mode: a height the seller states wrongly is caught against what two light servers return", async () => {
  // Blocks 4200100 to 4200105. Every block a real server serves holds a transaction, so the first
  // five carry unrelated payments (other people's, unreadable with the lot key) and Dave's late
  // bid sits in 4200105, where the servers say it is.
  const offline = JSON.parse(readFileSync(new URL("../vectors/offline-vectors.json", import.meta.url), "utf8"));
  const filler = ["orchard_v5_payment", "orchard_v5_refund", "orchard_nu6_2_payment", "ironwood_v6_payment", "ironwood_v6_refund"].map((n) => ({
    txid: offline.cases[n].txid as string,
    txHex: offline.cases[n].txHex as string,
  }));
  const dave = honest.chain.blocks.find((b) => b.height === 4200105)!.txs;
  const served = new Map<number, { txid: string; txHex: string }[]>();
  filler.forEach((t, i) => served.set(4200100 + i, [t]));
  served.set(4200105, dave);
  const a = await fakeLightServer(served);
  const b = await fakeLightServer(served);
  const daveTx = honest.d.transactions.find((t: any) => t.txid === dave[0].txid);
  const lot = (height: number) => ({
    ...honest.d,
    openHeight: 4200100,
    refundByHeight: 4200100,
    transactions: [{ ...daveTx, height }],
  });
  const fetched = await fetchBlocks({ network: "test", from: 4200100, to: 4200105, servers: [a.url, b.url], concurrency: 2, groupSize: 1 });
  const input = (): ScanInput => ({ blocks: fetched.blocks, missing: [], source: fetched.source, graceBlocks: 5 });
  const claims = (height: number) => {
    const d = lot(height);
    const v = checkLot(d, { ...honest.r, bids: [], bidCount: 0, winners: [], refunds: [], clearingPriceZat: 0, reserveMet: false }, { scan: input() });
    return v.checks.find((c) => c.id === "scan-heights")!;
  };
  const wrong = claims(4200099);
  assert.equal(wrong.status, "FAIL");
  assert.match(wrong.reason, /wrong height: .*the seller says block 4200099, the chain shows block 4200105 \(on the other side of the close at 4200100\)/);
  assert.equal(claims(4200105).status, "PASS");
  assert.deepEqual(fetched.source.serversContacted, [a.url, b.url]);
});

// ---------- --server: use your own node ----------

test("fetchBlocks with one server and no cross-check reads from just that server", async () => {
  const mine = await fakeLightServer(someBlocks);
  const h = [...someBlocks.keys()][0];
  const r = await fetchBlocks({ network: "test", from: h, to: h, servers: [mine.url], crossCheck: false });
  assert.deepEqual(r.source.serversContacted, [mine.url]);
  assert.deepEqual(r.blocks[0].txs.map((t) => t.txid), someBlocks.get(h)!.map((t) => t.txid));
  // By default one server is not enough: two operators must agree.
  await assert.rejects(fetchBlocks({ network: "test", from: h, to: h, servers: [mine.url], retries: 0 }));
});

test("CLI --server: bad address and missing --fetch are refused before any connection", async () => {
  const base = ["check", "--disclosure", path("scan-01/disclosure.json"), "--result", path("scan-01/result.json"), "--scan"];
  for (const bad of ["not a url", "ftp://node.example:9067", "https://node.example:9067/path", "https://user:pw@node.example", "https://ok.example:9067,nope"]) {
    const res = await runAsync([...base, "--fetch", "--server", bad]);
    assert.equal(res.code, 2, bad);
    assert.match(res.stderr, /--server .* is not a server address/, bad);
    assert.match(res.stderr, /Servers contacted: none$/);
  }
  const noFetch = run([...base, "--chain", path("scan-01/chain.json"), "--server", "https://node.example:9067"]);
  assert.equal(noFetch.code, 2);
  assert.match(noFetch.stderr, /only apply with --fetch/);
  const bidder = await runAsync(["bidder-check", "--facts", "x.json", "--key-file", "k.txt", "--fetch", "--server", "gopher://x"]);
  assert.equal(bidder.code, 2);
  assert.match(bidder.stderr, /is not a server address/);
});

test("CLI --server: only the chosen server is contacted, never the public ones", async () => {
  const mine = await fakeLightServer(someBlocks);
  const args = ["check", "--disclosure", path("scan-01/disclosure.json"), "--result", path("scan-01/result.json"), "--scan", "--fetch", "--concurrency", "1"];
  const res = await runAsync([...args, "--server", mine.url]);
  // The fake serves only some blocks, so the run stops, but it must name only the server we chose.
  assert.match(res.stderr + res.stdout, new RegExp(`Servers contacted: ${mine.url.replace(/[.]/g, "\.")}$`, "m"));
  assert.ok(!/zec\.rocks|cipherscan/.test(res.stderr + res.stdout), "no public server was contacted");
});
