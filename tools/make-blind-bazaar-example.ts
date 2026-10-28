// Saves the public evidence of one lot of another Zcash auction project, Blind Bazaar (MIT licence, credited in
// THIRD_PARTY.md), so Imani can re-check it offline. Run: node tools/make-blind-bazaar-example.ts
// It downloads three of their published files from GitHub and the lot's blocks from two public test-network servers.
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchBlocks } from "../src/scan/fetch-blocks.ts";

const LOT = "testnet-ejp8jz0s";
const BASE = `https://raw.githubusercontent.com/Don-Vicks/blind-bazaar/main/docs/evidence/${LOT}/`;
const out = new URL(`../examples/external-lots/blind-bazaar-${LOT}/`, import.meta.url);
mkdirSync(out, { recursive: true });
for (const f of ["lot.json", "result.json", "result-tampered.json"]) {
  const res = await fetch(BASE + f);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  writeFileSync(new URL(f, out), JSON.stringify(json, null, 2) + "\n");
}
const lot = JSON.parse(await (await fetch(BASE + "lot.json")).text());
const { blocks, source } = await fetchBlocks({ network: "test", from: lot.audit_birthday, to: lot.close_height + 18 });
writeFileSync(
  new URL("chain.json", out),
  JSON.stringify({ format: "imani-chain/1", network: "test", about: `Blocks ${lot.audit_birthday} to ${lot.close_height + 18} of the Zcash test network, as returned by two public servers run by different people that agreed on every block.`, blocks }) + "\n",
);
console.log(`saved ${blocks.length} blocks from ${source.serversContacted.join(", ")}`);
