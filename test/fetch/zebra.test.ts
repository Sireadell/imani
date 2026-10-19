// Zebra route tests. Everything runs on this machine: a fake Zebra node (JSON-RPC over node:http)
// and a fake light server (gRPC over node:http2), both serving real Zcash testnet blocks.
// The blocks come from the example round in examples/testnet-01; three of them, with their real
// hashes, are saved in test/fixtures/zebra-getblock.json in the shape of Zebra's getblock reply.
// No real Zebra node was available when these were written; the method names, parameters,
// password rule and reply shape follow ZcashFoundation/zebra (zebra-rpc), see docs/fetch/DESIGN.md.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { fetchTransactions, FetchError, operatorOf } from "../../src/fetch/index.ts";
import { fieldBytes, fieldVarint, decodeMessage, txidToBytes, bytesToTxid } from "../../src/fetch/grpc.ts";
import { loadZebraAuth, ZEBRA_AUTH_ENV } from "../../src/fetch/zebra.ts";
import { fetchBlocks } from "../../src/scan/fetch-blocks.ts";
import { runAsync } from "../../src/cli.ts";

type Tx = { txid: string; hex: string };
type Blk = { hash: string; height: number; tx: Tx[] };
const fixture = JSON.parse(readFileSync(new URL("../fixtures/zebra-getblock.json", import.meta.url), "utf8")).blocks as Record<string, Blk>;
const chain = JSON.parse(readFileSync(new URL("../../examples/testnet-01/chain.json", import.meta.url), "utf8")) as {
  blocks: { height: number; txs: { txid: string; txHex: string }[] }[];
};
const HEIGHTS = [4489078, 4489080, 4489093];
const SECRET = "s3cr3tCookieValueABC123";

/** Every block of the example round, in Zebra's reply shape. The three recorded ones keep their real hash. */
function allBlocks(): Record<number, Blk> {
  const out: Record<number, Blk> = {};
  for (const b of chain.blocks) {
    out[b.height] = fixture[b.height] ?? { hash: b.height.toString(16).padStart(64, "0"), height: b.height, tx: b.txs.map((t) => ({ txid: t.txid, hex: t.txHex })) };
  }
  return out;
}

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

interface ZebraBehaviour {
  chain?: string;
  blocks?: Record<number, Blk>;
  /** Password the node insists on (the part after the first colon of the Basic auth text). */
  password?: string;
  /** Replace one transaction's bytes in every reply, keeping its claimed txid. */
  corrupt?: { txid: string; hex: string };
  /** Reply to getblock with this JSON-RPC error. */
  blockError?: { code: number; message: string };
}

async function fakeZebra(b: ZebraBehaviour = {}) {
  const seen: { method: string; params: unknown[]; auth: string | undefined }[] = [];
  const blocks = b.blocks ?? fixture;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const reply = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: unknown; method: string; params: unknown[] };
      seen.push({ method: call.method, params: call.params, auth: req.headers.authorization });
      if (b.password !== undefined) {
        // Same rule as zebra-rpc: "Basic <base64>", the text after the first ":" must match.
        const decoded = Buffer.from((req.headers.authorization ?? "").split(/\s+/)[1] ?? "", "base64").toString("utf8");
        if (decoded.split(":")[1] !== b.password) return reply(401, undefined);
      }
      const ok = (result: unknown) => reply(200, { jsonrpc: "2.0", id: call.id, result });
      if (call.method === "getblockchaininfo") return ok({ chain: b.chain ?? "test", blocks: 4489110 });
      if (call.method === "getblock") {
        if (b.blockError) return reply(200, { jsonrpc: "2.0", id: call.id, error: b.blockError });
        const blk = blocks[Number(call.params[0])];
        if (!blk) return reply(200, { jsonrpc: "2.0", id: call.id, error: { code: -8, message: "Block not found" } });
        const tx = blk.tx.map((t) => (b.corrupt && t.txid === b.corrupt.txid ? { ...t, hex: b.corrupt.hex } : t));
        return ok({ hash: blk.hash, confirmations: 10, height: blk.height, tx });
      }
      if (call.method === "getrawtransaction") {
        for (const blk of Object.values(blocks)) {
          const t = blk.tx.find((x) => x.txid === call.params[0]);
          if (t) return ok({ hex: t.hex, height: blk.height, txid: t.txid });
        }
        return reply(200, { jsonrpc: "2.0", id: call.id, error: { code: -5, message: "No such mempool or main chain transaction" } });
      }
      reply(200, { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "Method not found" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `zebra+http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen };
}

/** A fake light server holding the same blocks. */
async function fakeLight(blocks: Record<number, Blk>, chainName = "test", dropTx?: string) {
  const txs = new Map<string, { hex: string; height: number }>();
  for (const blk of Object.values(blocks)) for (const t of blk.tx) txs.set(t.txid, { hex: t.hex, height: blk.height });
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
      if (method === "GetLightdInfo") reply = Buffer.concat([fieldBytes(1, Buffer.from("v0")), fieldBytes(4, Buffer.from(chainName)), fieldVarint(7, 4489200n)]);
      else if (method === "GetTransaction") {
        const hash = msg.find((f) => f.field === 3)?.bytes;
        const t = hash ? txs.get(bytesToTxid(hash)) : undefined;
        if (!t) status = "5";
        else reply = Buffer.concat([fieldBytes(1, Buffer.from(t.hex, "hex")), fieldVarint(2, BigInt(t.height))]);
      } else if (method === "GetBlock") {
        const blk = blocks[Number(msg.find((f) => f.field === 1)?.varint ?? 0n)];
        if (!blk) status = "5";
        else {
          const ids = blk.tx.map((t) => t.txid).filter((t) => t !== dropTx);
          reply = Buffer.concat([
            fieldVarint(2, BigInt(blk.height)),
            // Light servers send hashes in internal order; the helper flips them to display order.
            fieldBytes(3, txidToBytes(blk.hash)),
            ...ids.map((t, i) => fieldBytes(7, Buffer.concat([fieldVarint(1, BigInt(i)), fieldBytes(2, txidToBytes(t))]))),
          ]);
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tmp = mkdtempSync(join(tmpdir(), "imani-zebra-"));
const cookieFile = (text: string) => {
  const p = join(tmp, `cookie-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, text);
  return p;
};
const expected = (heights: number[]) => heights.map((h) => ({ height: h, txs: chain.blocks.find((b) => b.height === h)!.txs }));

test("zebra: three real testnet blocks come back byte for byte as the example round holds them", async () => {
  const z = await fakeZebra();
  const r = await fetchBlocks({ network: "test", from: 4489078, to: 4489078, servers: [z.url], crossCheck: false });
  const blocks = [];
  for (const h of HEIGHTS) blocks.push((await fetchBlocks({ network: "test", from: h, to: h, servers: [z.url], crossCheck: false })).blocks[0]);
  assert.deepEqual(blocks, expected(HEIGHTS));
  assert.equal(r.source.kind, "light-servers");
  assert.match(r.source.label, /Zebra node you chose/);
  assert.deepEqual(r.source.serversContacted, [z.url]);
});

test("zebra: asks for the height as a string with verbosity 2, and checks the network first", async () => {
  const z = await fakeZebra();
  await fetchTransactions({ network: "test", heights: [4489080], servers: [z.url], crossCheck: false });
  assert.deepEqual(z.seen.map((s) => s.method), ["getblockchaininfo", "getblock"]);
  assert.deepEqual(z.seen[1].params, ["4489080", 2]);
});

test("zebra: the same blocks through a Zebra node and through a light server are identical", async () => {
  const z = await fakeZebra();
  const light = await fakeLight(fixture as unknown as Record<number, Blk>);
  for (const h of HEIGHTS) {
    const viaZebra = await fetchBlocks({ network: "test", from: h, to: h, servers: [z.url], crossCheck: false });
    const viaLight = await fetchBlocks({ network: "test", from: h, to: h, servers: [light], crossCheck: false });
    assert.deepEqual(viaZebra.blocks, viaLight.blocks);
  }
});

test("zebra: counts as a second independent source next to a light server", async () => {
  const z = await fakeZebra();
  const light = await fakeLight(fixture as unknown as Record<number, Blk>);
  assert.notEqual(operatorOf(z.url), operatorOf(light));
  const r = await fetchTransactions({ network: "test", heights: [4489093], servers: [light, z.url] });
  assert.equal(r.transactions.length, 4);
  for (const t of r.transactions) assert.deepEqual(t.confirmedBy.sort(), [light, z.url].sort());
  assert.equal(r.transactions[0].height, 4489093);
  const label = (await fetchBlocks({ network: "test", from: 4489093, to: 4489093, servers: [light, z.url] })).source.label;
  assert.match(label, /Zebra node and another server, two independent operators agreeing/);
});

test("zebra: a light server and a node that disagree about a block's transactions stop the fetch", async () => {
  const z = await fakeZebra();
  const light = await fakeLight(fixture as unknown as Record<number, Blk>, "test", fixture[4489093].tx[3].txid);
  await assert.rejects(fetchTransactions({ network: "test", heights: [4489093], servers: [light, z.url] }), /servers disagree about block 4489093/);
});

test("zebra: a node that disagrees about a block's hash stops the fetch", async () => {
  const other = { ...fixture, 4489080: { ...fixture[4489080], hash: "ab".repeat(32) } };
  const z = await fakeZebra({ blocks: other });
  const light = await fakeLight(fixture as unknown as Record<number, Blk>);
  await assert.rejects(fetchTransactions({ network: "test", heights: [4489080], servers: [light, z.url] }), /servers disagree about block 4489080/);
});

test("zebra: a transaction whose bytes do not match its id is refused", async () => {
  const t = fixture[4489078].tx[1];
  const other = fixture[4489078].tx[0].hex;
  const z = await fakeZebra({ corrupt: { txid: t.txid, hex: other } });
  await assert.rejects(
    fetchTransactions({ network: "test", heights: [4489078], servers: [z.url], crossCheck: false }),
    (e: Error) => e instanceof FetchError && /could not get verified bytes/.test(e.message) && e.problems.some((p) => /different txid/.test(p.error)),
  );
});

test("zebra: a node on the other network is refused", async () => {
  const z = await fakeZebra({ chain: "main" });
  await assert.rejects(fetchTransactions({ network: "test", heights: [4489080], servers: [z.url], crossCheck: false }), (e: Error) => e instanceof FetchError && e.problems.some((p) => /serves the "main" network, not "test"/.test(p.error)));
});

test("zebra: a block the node does not have gives a clear error", async () => {
  const z = await fakeZebra();
  await assert.rejects(fetchTransactions({ network: "test", heights: [4489081], servers: [z.url], crossCheck: false }), (e: Error) => e instanceof FetchError && e.problems.some((p) => /node error -8: Block not found/.test(p.error)));
});

test("zebra: single transaction by id works through getrawtransaction", async () => {
  const z = await fakeZebra();
  const t = fixture[4489093].tx[2];
  const r = await fetchTransactions({ network: "test", txids: [t.txid], servers: [z.url], crossCheck: false });
  assert.equal(r.transactions[0].hex, t.hex);
  assert.equal(r.transactions[0].height, 4489093);
  assert.deepEqual(z.seen.map((s) => s.method), ["getblockchaininfo", "getrawtransaction"]);
  assert.deepEqual(z.seen[1].params, [t.txid, 1]);
});

test("zebra auth: no password, wrong password, right password (cookie file)", async () => {
  const z = await fakeZebra({ password: SECRET });
  const run = (auth?: string) => fetchTransactions({ network: "test", heights: [4489080], servers: [z.url], crossCheck: false, zebraAuth: auth, retries: 0 });
  const msg = async (auth?: string) => {
    try {
      await run(auth);
    } catch (e) {
      return (e as FetchError).problems.map((p) => p.error).join(" | ");
    }
    return "";
  };
  assert.match(await msg(undefined), /wants a password/);
  assert.match(await msg("__cookie__:wrong"), /refused the password/);
  const file = cookieFile(`__cookie__:${SECRET}\n`);
  const ok = await run(loadZebraAuth(file));
  assert.equal(ok.transactions.length, 1);
  // The Basic header carries the cookie text exactly as Zebra writes it.
  const last = z.seen[z.seen.length - 1];
  assert.equal(Buffer.from(last.auth!.split(" ")[1], "base64").toString(), `__cookie__:${SECRET}`);
});

test("zebra auth: the password never appears in errors, results or the command output", async () => {
  const z = await fakeZebra({ password: SECRET });
  const everything: string[] = [];
  try {
    await fetchTransactions({ network: "test", heights: [4489080], servers: [z.url], crossCheck: false, zebraAuth: "__cookie__:not-it", retries: 0 });
  } catch (e) {
    everything.push((e as Error).message, JSON.stringify((e as FetchError).problems), JSON.stringify((e as FetchError).serversContacted));
  }
  const ok = await fetchTransactions({ network: "test", heights: [4489080], servers: [z.url], crossCheck: false, zebraAuth: `__cookie__:${SECRET}` });
  everything.push(JSON.stringify(ok));
  assert.ok(everything.length >= 4);
  for (const text of everything) assert.ok(!text.includes(SECRET) && !text.includes("not-it"), text.slice(0, 120));
});

test("zebra auth: the password is read from a file or the environment, one line, bare secret allowed", () => {
  assert.equal(loadZebraAuth(cookieFile("__cookie__:abc==\n")), "__cookie__:abc==");
  assert.equal(loadZebraAuth(cookieFile("user:pw")), "user:pw");
  assert.equal(loadZebraAuth(cookieFile("justasecret")), ":justasecret");
  assert.equal(loadZebraAuth(undefined, { [ZEBRA_AUTH_ENV]: "__cookie__:fromenv" }), "__cookie__:fromenv");
  assert.equal(loadZebraAuth(cookieFile("file:wins"), { [ZEBRA_AUTH_ENV]: "env:loses" }), "file:wins");
  assert.equal(loadZebraAuth(undefined, {}), undefined);
  assert.throws(() => loadZebraAuth(cookieFile("a:b\nc:d")), /one line/);
  assert.throws(() => loadZebraAuth(cookieFile("   ")), /one line/);
  assert.throws(() => loadZebraAuth(join(tmp, "missing-file")), /could not read the Zebra password file/);
});

test("zebra auth: a password is never sent over plain http to a machine that is not yours, and never goes in the address", async () => {
  await assert.rejects(
    fetchTransactions({ network: "test", heights: [4489080], servers: ["zebra+http://203.0.113.9:8232"], crossCheck: false, zebraAuth: "a:b", retries: 0, timeoutMs: 500 }),
    (e: Error) => e instanceof FetchError && e.problems.some((p) => /refusing to send a password over plain http/.test(p.error)),
  );
  await assert.rejects(fetchTransactions({ network: "test", heights: [4489080], servers: ["zebra+http://user:pw@127.0.0.1:1"], crossCheck: false }), /server must be just scheme, host and port/);
});

// ---- the whole command, against a fake node holding the full example round ----

test("zebra: the whole scan of the real testnet round passes 21 of 21 from a Zebra node, same as offline", async () => {
  const z = await fakeZebra({ blocks: allBlocks(), password: SECRET });
  const file = cookieFile(`__cookie__:${SECRET}`);
  const ex = (p: string) => fileURLToPath(new URL(`../../examples/${p}`, import.meta.url));
  const base = ["check", "--disclosure", ex("testnet-01/disclosure.json"), "--result", ex("testnet-01/result.json"), "--scan"];
  const online = await runAsync([...base, "--fetch", "--server", z.url, "--zebra-auth-file", file]);
  assert.equal(online.code, 0, online.stderr);
  assert.match(online.stdout, /RESULT: PASS \(21 of 21 checks passed\)/);
  assert.match(online.stdout, /Read all 34 blocks from 4489077 to 4489110 \(80 transactions\)/);
  assert.match(online.stdout, /the Zebra node you chose/);
  assert.ok(online.stdout.includes(`Servers contacted: ${z.url}`));
  assert.ok(!online.stdout.includes(SECRET) && !online.stderr.includes(SECRET));
  // Same verdict lines as the offline run on the same blocks.
  const offline = await runAsync([...base, "--chain", ex("testnet-01/chain.json")]);
  // Only the line that names where the blocks came from may differ.
  const verdict = (s: string) => s.split("\n").filter((l) => /^\s*(PASS|FAIL)|RESULT:/.test(l) && !l.includes("Every block in the lot's range was read"));
  assert.ok(verdict(online.stdout).length >= 21);
  assert.deepEqual(verdict(online.stdout), verdict(offline.stdout));
});

test("zebra: the command says so when the node wants a password and none was given", async () => {
  const z = await fakeZebra({ blocks: allBlocks(), password: SECRET });
  const ex = (p: string) => fileURLToPath(new URL(`../../examples/${p}`, import.meta.url));
  const r = await runAsync(["check", "--disclosure", ex("testnet-01/disclosure.json"), "--result", ex("testnet-01/result.json"), "--scan", "--fetch", "--server", z.url]);
  assert.equal(r.code, 2);
  assert.match(r.stderr + r.stdout, /wants a password/);
});

test("zebra: --zebra-auth-file needs --fetch and an existing file", async () => {
  const ex = (p: string) => fileURLToPath(new URL(`../../examples/${p}`, import.meta.url));
  const args = ["check", "--disclosure", ex("testnet-01/disclosure.json"), "--result", ex("testnet-01/result.json"), "--scan"];
  const a = await runAsync([...args, "--chain", ex("testnet-01/chain.json"), "--zebra-auth-file", "x"]);
  assert.equal(a.code, 2);
  assert.match(a.stderr, /only apply with --fetch/);
  const b = await runAsync([...args, "--fetch", "--server", "zebra+http://127.0.0.1:1", "--zebra-auth-file", join(tmp, "nope")]);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /could not read the Zebra password file/);
});

// ---- optional live test: IMANI_ZEBRA_URL=zebra+http://127.0.0.1:18232 LIVE=1 npm run test:fetch ----
// Runs only when you point it at a real node of your own (and IMANI_ZEBRA_AUTH holds its cookie, if it has one).

test("live: a real Zebra node returns the same testnet block as the example round", { skip: (process.env.LIVE !== "1" || !process.env.IMANI_ZEBRA_URL) && "set LIVE=1 and IMANI_ZEBRA_URL to a testnet node of your own" }, async () => {
  const r = await fetchBlocks({ network: "test", from: 4489078, to: 4489078, servers: [process.env.IMANI_ZEBRA_URL!], crossCheck: false, zebraAuth: loadZebraAuth() });
  assert.deepEqual(r.blocks, expected([4489078]));
});
