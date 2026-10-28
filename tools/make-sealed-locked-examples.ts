// Builds examples/sealed-locked-broken: two copies of examples/sealed-01 that break the "seller
// locked out until the close" promise. They are not part of the conformance kit.
// Run: node tools/make-sealed-locked-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const disclosure = read<Disclosure>("examples/sealed-01/disclosure.json");
const result = read<SellerResult>("examples/sealed-01/result.json");
const v = read<{ transactions: Record<string, { txid: string }> }>("test/vectors/sealed-round.json");
const id = (label: string) => v.transactions[label].txid;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/sealed-locked-broken/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};

rmSync(new URL("examples/sealed-locked-broken/", root), { recursive: true, force: true });

const copies: { name: string; story: string; changed: string; make: () => [Disclosure, SellerResult] }[] = [
  {
    name: "01-counts-early-opening",
    story: "Alice sent her opening at the close, while bidding was still open, so the seller could read her price early. An opening at the close never counts, but the seller counts her at 3,000,000 anyway.",
    changed: "disclosure.json (the height of Alice's opening)",
    make: () => {
      const d = clone(disclosure);
      d.transactions = d.transactions.map((t) => (t.txid === id("open_alice") ? { ...t, height: d.closeHeight } : t));
      return [d, clone(result)];
    },
  },
  {
    name: "02-tampered-commitment",
    story: "Erin sealed 900,000 and then opened 800,000, which does not match her seal. The seller counts her at the 900,000 she sealed, a price she never opened.",
    changed: "result.json",
    make: () => {
      const r = clone(result);
      r.bids.push({ txid: id("seal_erin_badhash"), amountZat: 900_000 });
      r.bidCount = 4;
      return [clone(disclosure), r];
    },
  },
];

for (const c of copies) {
  const [d, r] = c.make();
  write(c.name, d, r);
}
// Expected failing checks are pinned from the first run, then fixed in the manifest.
import { checkLot } from "../src/check.ts";
const manifest = {
  about: "Two broken copies of examples/sealed-01 that break the seller-locked-out promise. Each fails the named checks. They are not in the conformance kit.",
  copies: copies.map((c) => {
    const [d, r] = c.make();
    const failed = checkLot(d, r).checks.filter((x) => x.status === "FAIL").map((x) => x.id);
    return { name: c.name, changed: c.changed, expectedFailingChecks: failed, story: c.story };
  }),
};
writeFileSync(new URL("examples/sealed-locked-broken/expected.json", root), JSON.stringify(manifest, null, 2) + "\n");
console.log("wrote examples/sealed-locked-broken", manifest.copies.map((c) => `${c.name}: ${c.expectedFailingChecks.join(",")}`).join(" | "));
