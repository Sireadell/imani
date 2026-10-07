import { createRequire } from "node:module";

// Prebuilt WebAssembly decoder (librustzcash). Source and rebuild steps: tools/decoder/.
// Checksums of the shipped files: vendor/decoder/SHA256SUMS.
const require = createRequire(import.meta.url);
const decoder = require("../vendor/decoder/imani_decoder.js") as {
  decryptTx(txHex: string, ufvk: string): DecodedTx;
};

export type TransferType = "incoming" | "outgoing" | "internal";
export type Pool = "orchard" | "ironwood" | "sapling";

export interface ReadOutput {
  pool: Pool;
  amountZat: number;
  memo: string;
  transferType: TransferType;
}

interface DecodedOutput {
  index: number;
  amountZat: number;
  memo: string;
  memoHex: string;
  transferType: TransferType;
}

interface DecodedTx {
  txid: string;
  txVersion: number;
  branchId: string;
  orchard: DecodedOutput[];
  ironwood: DecodedOutput[];
  sapling: DecodedOutput[];
}

/**
 * Read one raw transaction with a unified full viewing key and return every output the key can see.
 * A viewing key is read-only: it can show payments, never spend them.
 * The network comes from the key (uview1 is mainnet, uviewtest1 is testnet), and the transaction
 * version and network upgrade come from the transaction bytes, so no block height is needed.
 */
export function readTransaction(txHex: string, viewingKey: string): ReadOutput[] {
  const result = decoder.decryptTx(txHex, viewingKey);
  const out: ReadOutput[] = [];
  for (const pool of ["orchard", "ironwood", "sapling"] as const) {
    for (const o of result[pool]) {
      out.push({ pool, amountZat: o.amountZat, memo: o.memo, transferType: o.transferType });
    }
  }
  return out;
}
