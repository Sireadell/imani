// Standalone fetch script. Running it is the opt-in: it contacts public servers.
//   node --import tsx src/fetch/cli.ts --network test --txid <txid> [--txid ...]
//   node --import tsx src/fetch/cli.ts --network main --height 3509784 --out block.json
// Options: --server <url> (repeat; replaces the defaults), --single-server (no cross-check),
// --proxy socks5h://127.0.0.1:9050, --timeout <ms>, --out <file>.
// Prints the servers it contacted. Never asks for, reads or sends a key.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchTransactions, FetchError, type FetchOptions, type Network } from "./index.ts";

export async function main(argv: string[], log = console.log, err = console.error): Promise<number> {
  const opts: FetchOptions = { network: "main", txids: [], heights: [] };
  const servers: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--network") opts.network = next() as Network;
    else if (a === "--txid") opts.txids!.push(next());
    else if (a === "--height") opts.heights!.push(Number(next()));
    else if (a === "--server") servers.push(next());
    else if (a === "--single-server") opts.crossCheck = false;
    else if (a === "--proxy") opts.proxy = next();
    else if (a === "--timeout") opts.timeoutMs = Number(next());
    else if (a === "--out") out = next();
    else {
      err(`unknown option ${a}`);
      return 2;
    }
  }
  if (servers.length) opts.servers = servers;
  try {
    const r = await fetchTransactions(opts);
    for (const t of r.transactions) {
      log(`${t.txid}  ${t.hex.length / 2} bytes  height ${t.height ?? "unknown"}  checked by ${t.confirmedBy.length} server(s)`);
    }
    for (const p of r.problems) log(`note: ${p.server}: ${p.error}`);
    log(`servers contacted: ${r.serversContacted.join(", ")}`);
    if (out) {
      writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
      log(`saved ${r.transactions.length} transaction(s) to ${out}`);
    }
    return 0;
  } catch (e) {
    err(`fetch failed: ${(e as Error).message}`);
    if (e instanceof FetchError) {
      for (const p of e.problems) err(`note: ${p.server}: ${p.error}`);
      err(`servers contacted: ${e.serversContacted.join(", ") || "none"}`);
    }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
