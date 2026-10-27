// Share links: one link names a round and re-runs the check in the visitor's browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseShareTarget, shareLink } from "../../src/site/share.ts";

const root = new URL("../../", import.meta.url);
const rd = (p: string) => readFileSync(new URL(p, root), "utf8");

test("hash and query forms both name a round", () => {
  assert.deepEqual(parseShareTarget("", "#round=testnet-01"), { kind: "round", id: "testnet-01" });
  assert.deepEqual(parseShareTarget("?round=testnet-01", ""), { kind: "round", id: "testnet-01" });
  assert.deepEqual(parseShareTarget("?external=abc", ""), { kind: "external", id: "abc" });
  assert.deepEqual(parseShareTarget("?round=a", "#round=b"), { kind: "round", id: "b" });
});

test("no target, or a broken one, gives nothing or a plain id", () => {
  assert.equal(parseShareTarget("", ""), null);
  assert.equal(parseShareTarget("?x=1", "#other=2"), null);
  assert.equal(parseShareTarget("", "#round=%E0%A4%A")?.id, "%E0%A4%A");
});

test("a copied link keeps only the page address plus the round name", () => {
  assert.equal(shareLink("https://x.test/index.html?a=1#round=old", { kind: "round", id: "testnet-01" }), "https://x.test/index.html#round=testnet-01");
  assert.equal(shareLink("https://x.test/", { kind: "round", id: "a b" }), "https://x.test/#round=a%20b");
});

test("the page wires the link in, and the link contains no key or amount", () => {
  assert.match(rd("src/site/static/index.html"), /id="share-out"/);
  const app = rd("src/site/app.ts");
  assert.match(app, /parseShareTarget\(location\.search, location\.hash\)/);
  assert.match(app, /showShareLink\(\{ kind: "round", id \}\)/);
  assert.doesNotMatch(shareLink("https://x.test/", { kind: "round", id: "testnet-01" }), /uview|ufvk|zat/i);
});
