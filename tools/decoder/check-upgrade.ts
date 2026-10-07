// Compares the newest network upgrade the bundled decoder reads with what public light
// wallet servers report right now (GetLightdInfo: current consensus branch id, and the
// next scheduled upgrade with its height). Sends no key, no txid and no address.
//   node --import tsx tools/decoder/check-upgrade.ts [--network main|test] [--server https://host:port ...]
// Exit code 0: the decoder reads today's transactions and knows the next scheduled upgrade.
// Exit code 1: the network already uses an upgrade the decoder does not know (rebuild now).
// Exit code 2: an upgrade the decoder does not know is scheduled (rebuild before its height).
// Exit code 3: no server answered.

import { fileURLToPath } from "node:url";
import { decodeMessage, unary } from "../../src/fetch/grpc.ts";
import { decoderInfo } from "../../src/read.ts";

const DEFAULTS: Record<string, string[]> = {
  main: ["https://zec.rocks:443", "https://zec-node.cakewallet.com:443"],
  test: ["https://testnet.zec.rocks:443"],
};

export interface ServerUpgradeInfo {
  server: string;
  chainName: string;
  blockHeight: number;
  consensusBranchId: string;
  upgradeName: string;
  upgradeHeight: number;
}

export function decodeUpgradeInfo(server: string, buf: Buffer): ServerUpgradeInfo {
  const r: ServerUpgradeInfo = { server, chainName: "", blockHeight: 0, consensusBranchId: "", upgradeName: "", upgradeHeight: 0 };
  for (const f of decodeMessage(buf)) {
    if (f.field === 4 && f.bytes) r.chainName = f.bytes.toString("utf8");
    if (f.field === 6 && f.bytes) r.consensusBranchId = "0x" + f.bytes.toString("utf8").toLowerCase().replace(/^0x/, "").padStart(8, "0");
    if (f.field === 7 && f.varint !== undefined) r.blockHeight = Number(f.varint);
    if (f.field === 16 && f.bytes) r.upgradeName = f.bytes.toString("utf8");
    if (f.field === 17 && f.varint !== undefined) r.upgradeHeight = Number(f.varint);
  }
  return r;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function main(argv: string[], log = console.log): Promise<number> {
  let network = "main";
  const servers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--network") network = argv[++i];
    else if (argv[i] === "--server") servers.push(argv[++i]);
  }
  const info = decoderInfo();
  const known = new Map(info.upgrades.map((u) => [u.branchId, u.name]));
  log(`decoder reads up to ${info.highestUpgrade} (${info.highestBranchId}), zcash_primitives ${info.librustzcash.zcash_primitives}`);

  let code = 3;
  for (const server of servers.length ? servers : DEFAULTS[network]) {
    let s: ServerUpgradeInfo;
    try {
      s = decodeUpgradeInfo(server, await unary(server, "GetLightdInfo", Buffer.alloc(0), { timeoutMs: 20000 }));
    } catch (e) {
      log(`${server}: no answer (${(e as Error).message})`);
      continue;
    }
    if (s.chainName !== network) {
      log(`${server}: serves "${s.chainName}", skipped`);
      continue;
    }
    const current = known.get(s.consensusBranchId);
    log(`${server}: height ${s.blockHeight}, current branch id ${s.consensusBranchId} (${current ?? "UNKNOWN to this decoder"})`);
    let c = current ? 0 : 1;
    if (s.upgradeName) {
      const pendingKnown = info.upgrades.some((u) => norm(u.name) === norm(s.upgradeName));
      log(`  next upgrade scheduled: ${s.upgradeName} at height ${s.upgradeHeight} (${pendingKnown ? "known to this decoder" : "NOT known to this decoder"})`);
      if (!pendingKnown && c === 0) c = 2;
    } else {
      log("  no upgrade scheduled");
    }
    code = code === 3 ? c : Math.max(code, c);
  }
  log(code === 0 ? "OK" : code === 1 ? "REBUILD NOW: current transactions cannot be read" : code === 2 ? "REBUILD SOON: an unknown upgrade is scheduled" : "NO ANSWER");
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
