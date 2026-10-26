// Locked answers for the bid link (a Zcash payment request, ZIP 321). Written before the code.
//   - The amount is decimal ZEC with a period and at most 8 digits after it (ZIP 321).
//   - The memo is base64url without padding, 512 bytes at most, and never goes to a transparent address.
//   - Reading the link back gives the same address, amount and memo that went in.
//   - A scanner reading the QR code gets back exactly the link (checked with an independent QR reader).
//   - The memo is a bid memo the checker itself accepts, with the bidder's refund address inside when given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import jsQRModule from "jsqr";
const jsQR = ((jsQRModule as any).default ?? jsQRModule) as typeof import("jsqr").default;
import { BidLinkError, makeBidLink, memoParam, qrMatrix, qrSvg, qrText, zatToZec, zecToZat } from "../src/bidlink.ts";
import { runBidLink } from "../src/bidlink-cli.ts";
import { bidMemoAddress, bidMemoPrefix } from "../src/files.ts";

const vec = JSON.parse(readFileSync(new URL("./vectors/auction-round.json", import.meta.url), "utf8"));
const LOT: string = vec.parties["lot LOT-01"].address;
const ALICE: string = vec.parties["bidder alice"].address;

/** A small reader written from the ZIP 321 grammar, to check what the builder wrote. */
function readUri(uri: string): { address: string; amount: string; memo: string } {
  assert.ok(uri.startsWith("zcash:"));
  assert.ok(!uri.includes("//"));
  const [address, query] = uri.slice("zcash:".length).split("?");
  const params = Object.fromEntries(query.split("&").map((p) => p.split("=") as [string, string]));
  assert.deepEqual(Object.keys(params).sort(), ["amount", "memo"]);
  assert.match(params.memo, /^[A-Za-z0-9_-]+$/);
  return { address, amount: params.amount, memo: Buffer.from(params.memo, "base64url").toString("utf8") };
}

test("zatoshis become decimal ZEC with at most 8 digits after the period", () => {
  assert.equal(zatToZec(100_000_000), "1");
  assert.equal(zatToZec(1), "0.00000001");
  assert.equal(zatToZec(1_500_000), "0.015");
  assert.equal(zatToZec(2_000_000_000), "20");
  assert.equal(zatToZec(123_456_789), "1.23456789");
  assert.equal(zatToZec(21_000_000 * 100_000_000), "21000000");
});

test("an amount typed in ZEC becomes whole zatoshis without rounding errors, and anything else is refused", () => {
  assert.equal(zecToZat("0.03"), 3_000_000);
  assert.equal(zecToZat("1"), 100_000_000);
  assert.equal(zecToZat(" 0.00000001 "), 1);
  assert.equal(zecToZat("0.1"), 10_000_000);
  assert.equal(zecToZat("1.23456789"), 123_456_789);
  for (const bad of ["", "0", "0.0", "-1", "1e3", "0.123456789", "1,5", "abc", "1.", ".5", "123456789"]) assert.equal(zecToZat(bad), null, bad);
});

test("the memo parameter is base64url with no padding, the same as Node's own encoder", () => {
  for (const m of ["bid:LOT-01:q7k2", "bid:LOT-01:a?&=b", "bid:L:zz:" + ALICE, "éè ~~~ >>>"]) {
    assert.equal(memoParam(m), Buffer.from(m, "utf8").toString("base64url"), m);
    assert.ok(!/[+/=]/.test(memoParam(m)));
  }
});

test("a bid link carries the lot address, the amount and a bid memo the checker accepts", () => {
  const l = makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 3_000_000, word: "q7k2" });
  assert.equal(l.memo, "bid:LOT-01:q7k2");
  assert.equal(l.network, "test");
  assert.deepEqual(readUri(l.uri), { address: LOT, amount: "0.03", memo: "bid:LOT-01:q7k2" });
});

test("the refund address goes inside the memo, where the checker reads it from", () => {
  const l = makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 3_000_000, word: "q7k2", refundAddress: ALICE });
  assert.equal(readUri(l.uri).memo, `bid:LOT-01:q7k2:${ALICE}`);
  assert.equal(bidMemoAddress("LOT-01", l.memo), ALICE);
});

test("with no code given, a random one is made, and two links differ", () => {
  const a = makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 1_000_000 });
  const b = makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 1_000_000 });
  assert.match(a.memo, new RegExp(`^${bidMemoPrefix("LOT-01")}[a-z0-9]{4}$`));
  assert.notEqual(a.memo, b.memo);
});

test("a ready-made memo, such as a sealed bid's, is used exactly", () => {
  const seal = "seal:LOT-01:ab12:" + "0".repeat(64);
  assert.equal(readUri(makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 5_000_000, memo: seal }).uri).memo, seal);
});

test("bad input is refused in plain words", () => {
  const ok = { lotId: "LOT-01", address: LOT, amountZat: 1_000_000, word: "ab" };
  assert.throws(() => makeBidLink({ ...ok, address: "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs" }), /not a shielded Zcash address/);
  assert.throws(() => makeBidLink({ ...ok, address: "hello" }), BidLinkError);
  assert.throws(() => makeBidLink({ ...ok, amountZat: 0 }), /whole number of zatoshis above 0/);
  assert.throws(() => makeBidLink({ ...ok, amountZat: 1.5 }), /whole number/);
  assert.throws(() => makeBidLink({ ...ok, amountZat: 21_000_001 * 100_000_000 }), /whole number/);
  assert.throws(() => makeBidLink({ ...ok, lotId: "bad lot" }), /lot name/);
  assert.throws(() => makeBidLink({ ...ok, word: "no good" }), /bidder code/);
  assert.throws(() => makeBidLink({ ...ok, refundAddress: "not an address" }), /refund address/);
  assert.throws(() => makeBidLink({ ...ok, refundAddress: "u1" + "q".repeat(100) }), /refund address/);
  assert.throws(() => makeBidLink({ ...ok, memo: "x".repeat(513) }), /512 bytes/);
});

test("a scanner reads the QR code back as exactly the link", () => {
  for (const l of [
    makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 3_000_000, word: "q7k2" }),
    makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 3_000_000, word: "q7k2", refundAddress: ALICE }),
  ]) {
    const m = qrMatrix(l.uri);
    const quiet = 4;
    const scale = 4;
    const side = (m.length + quiet * 2) * scale;
    const px = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) {
      if (!m[r][c]) continue;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
        const i = (((r + quiet) * scale + y) * side + (c + quiet) * scale + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
    const read = jsQR(px, side, side);
    assert.ok(read, "the QR code could not be read");
    assert.equal(read.data, l.uri);
  }
});

test("the text and picture versions draw something a person can use", () => {
  const l = makeBidLink({ lotId: "LOT-01", address: LOT, amountZat: 3_000_000, word: "q7k2" });
  assert.ok(qrText(l.uri).split("\n").length > 20);
  const svg = qrSvg(l.uri);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(!svg.includes("script"));
});

test("the command prints the link, the code and the memo, and contacts no server", () => {
  const r = runBidLink(["--lot", "LOT-01", "--address", LOT, "--amount-zat", "3000000", "--word", "q7k2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0\.03 ZEC \(3000000 zatoshis\)/);
  assert.match(r.stdout, /zcash:utest1[a-z0-9]+\?amount=0\.03&memo=/);
  assert.match(r.stdout, /Memo the wallet will send .*: bid:LOT-01:q7k2/);
  assert.match(r.stdout, /Servers contacted: none/);
});

test("the command refuses a transparent address, a missing amount and an unknown option with code 2", () => {
  assert.equal(runBidLink(["--lot", "LOT-01", "--address", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "--amount-zat", "5"]).code, 2);
  assert.equal(runBidLink(["--lot", "LOT-01", "--address", LOT]).code, 2);
  assert.equal(runBidLink(["--lot", "LOT-01", "--address", LOT, "--amount-zat", "5", "--bogus", "1"]).code, 2);
  assert.equal(runBidLink(["--lot", "LOT-01", "--address", LOT, "--amount-zat", "05"]).code, 2);
});
