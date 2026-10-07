// Builds examples/receivers-01 and examples/receivers-broken from examples/round-01 and the
// offline test transactions in test/vectors (made by tools/gen-vectors). No new transaction is
// made: the same round as round-01, with the address each bid's refund must go to listed in
// the disclosure. Run: node tools/make-receiver-examples.ts   Output is deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Disclosure, SellerResult } from "../src/files.ts";

const root = new URL("../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const v = json("test/vectors/auction-round.json");
const round: Disclosure = json("examples/round-01/disclosure.json");
const roundResult: SellerResult = json("examples/round-01/result.json");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const id = (label: string) => v.transactions[label].txid as string;
const addr = (party: string) => v.parties[party].address as string;

// The refund address each bidder gave for their bid (test addresses from test/vectors/auction-round.json).
const refundAddresses = [
  { bidTxid: id("bid_alice"), address: addr("bidder alice") },
  { bidTxid: id("bid_bob"), address: addr("bidder bob") },
  { bidTxid: id("bid_carol"), address: addr("bidder carol") },
  { bidTxid: id("bid_dave_late"), address: addr("bidder dave") },
];
const honest: Disclosure = { ...clone(round), refundAddresses };

const write = (dir: string, d: Disclosure, r: SellerResult) => {
  const u = new URL(`examples/${dir}/`, root);
  mkdirSync(u, { recursive: true });
  writeFileSync(new URL("disclosure.json", u), JSON.stringify(d, null, 2) + "\n");
  writeFileSync(new URL("result.json", u), JSON.stringify(r, null, 2) + "\n");
};

for (const dir of ["receivers-01", "receivers-broken"]) rmSync(new URL(`examples/${dir}/`, root), { recursive: true, force: true });
write("receivers-01", honest, clone(roundResult));

const broken: { name: string; story: string; expectedFailingCheck: string; changed: string; make: () => Disclosure }[] = [
  {
    name: "01-refund-to-other-address",
    story:
      "Carol's bid names her own address, but the refund the seller paid for it went to a different address. The amount and the memo are right, so the older checks pass. Only the receiver check sees it.",
    expectedFailingCheck: "refund-receivers",
    changed: "disclosure.json",
    make: () => {
      // The refund transaction is the honest one (it pays Carol). The list says it should have
      // gone to Dave's address, which stands for "an address that is not the one it paid".
      const d = clone(honest);
      d.refundAddresses = d.refundAddresses!.map((a) => (a.bidTxid === id("bid_carol") ? { ...a, address: addr("bidder dave") } : a));
      return d;
    },
  },
  {
    name: "02-refund-address-not-listed",
    story:
      "The seller lists a refund address for three of the four bids and leaves Carol's out. Once a seller lists refund addresses, every refunded bid needs one.",
    expectedFailingCheck: "refund-receivers",
    changed: "disclosure.json",
    make: () => {
      const d = clone(honest);
      d.refundAddresses = d.refundAddresses!.filter((a) => a.bidTxid !== id("bid_carol"));
      return d;
    },
  },
];

for (const b of broken) write(`receivers-broken/${b.name}`, b.make(), clone(roundResult));
writeFileSync(
  new URL("examples/receivers-broken/manifest.json", root),
  JSON.stringify(
    {
      about:
        "Broken copies of examples/receivers-01. The refund transactions are the real ones; only the list of refund addresses in disclosure.json changes. Each copy passes every other check and fails refund-receivers.",
      copies: broken.map(({ name, changed, expectedFailingCheck, story }) => ({ name, changed, expectedFailingCheck, story })),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote examples/receivers-01 and examples/receivers-broken (2 copies)");
