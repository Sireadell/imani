import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot } from "../src/check.ts";
import type { Disclosure, SellerResult } from "../src/files.ts";

const manifest = JSON.parse(readFileSync("examples/formats-01/manifest.json", "utf8"));
const read = (name: string, file: string) => JSON.parse(readFileSync(`examples/formats-01/${name}/${file}`, "utf8"));

for (const c of manifest.rounds as { name: string; expect: "PASS" | "FAIL"; failing?: string[] }[]) {
  test(`formats-01/${c.name}: ${c.expect === "PASS" ? "passes" : `fails on ${c.failing!.join(", ")}`}`, () => {
    const v = checkLot(read(c.name, "disclosure.json") as Disclosure, read(c.name, "result.json") as SellerResult);
    assert.equal(v.result, c.expect);
    assert.deepEqual([...v.failed].sort(), [...(c.failing ?? [])].sort());
  });
}

test("the one-item rounds really are one item, and the top-up round lets a bid be raised", () => {
  assert.equal(read("second-price", "result.json").rules.itemCount, 1);
  assert.equal(read("second-price", "result.json").rules.pricing, "highest-losing");
  assert.equal(read("first-price", "result.json").rules.itemCount, 1);
  assert.equal(read("first-price", "result.json").rules.pricing, "lowest-winning");
  const t = read("top-up", "result.json");
  assert.equal(t.rules.topUps, true);
  assert.equal(t.bids[0].amountZat, 6_000_000);
  assert.equal(read("top-up", "disclosure.json").transactions.filter((x: { txid: string; height: number }) => x.txid === t.bids[0].txid || x.height === 4200060).length, 2);
});
