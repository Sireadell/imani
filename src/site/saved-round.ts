// The offline way to check any round: the blocks come from a saved file (format imani-chain/1,
// as written by `imani fetch` or shipped in examples/), not from a server. Same checker, same
// answers. Nothing is requested: the file is read in this tab.
import { blocksInRange, ScanInputError, validateChainFile } from "../scan/chain.ts";
import { refereeRound, networkOfKey, type RefereeOutcome } from "./referee.ts";

export interface RoundFields {
  key: string;
  from: number;
  to: number;
  itemCount: number;
  reserveZat: number;
  pricing?: "highest-losing" | "lowest-winning";
  topUps?: boolean;
  closeHeight?: number;
  lotId?: string;
}

export function checkSavedRound(f: RoundFields, fileText: string, fileName: string): RefereeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return { ok: false, kind: "input", message: "Input error: that file is not a block file. Pick a saved block file in the imani-chain/1 format, such as chain.json from an example round." };
  }
  try {
    validateChainFile(parsed);
  } catch (e) {
    if (e instanceof ScanInputError) return { ok: false, kind: "input", message: e.message };
    throw e;
  }
  const network = networkOfKey(f.key);
  if (parsed.network !== network) {
    return { ok: false, kind: "input", message: `Input error: this block file is for the ${parsed.network} network, but the key is for the ${network} network.` };
  }
  const { blocks, missing } = blocksInRange(parsed, f.from, f.to);
  let bytes = 0;
  for (const b of blocks) for (const t of b.txs) bytes += t.txHex.length / 2;
  return refereeRound({
    ...f,
    blocks,
    missing,
    source: { kind: "chain-file", label: `the saved block file ${fileName.slice(0, 80)}`, serversContacted: [], bytes, ms: 0 },
  });
}
