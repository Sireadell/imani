import { createRequire } from "node:module";

// Prebuilt WebAssembly decoder (librustzcash). Source and rebuild steps: tools/decoder/.
// Checksums of the shipped files: vendor/decoder/SHA256SUMS.
const require = createRequire(import.meta.url);
const decoder = require("../vendor/decoder/imani_decoder.js") as {
  decryptTx(txHex: string, ufvk: string): DecodedTx;
  decoderInfo(): DecoderInfo;
};

/** What the bundled decoder can read. */
export interface DecoderInfo {
  decoder: string;
  /** librustzcash crate versions compiled into the decoder, for example { zcash_primitives: "0.31.0-pre.1" }. */
  librustzcash: Record<string, string>;
  /** Newest network upgrade the decoder reads, for example "NU7". */
  highestUpgrade: string;
  /** Its consensus branch id, for example "0x77190ad9". */
  highestBranchId: string;
  transactionVersions: number[];
  upgrades: { name: string; branchId: string; activationHeight: { main: number | null; test: number | null } }[];
}

/**
 * Versions and the newest network upgrade this build of the decoder understands. A transaction
 * from a newer upgrade is refused with "unsupported network upgrade 0x...".
 */
export function decoderInfo(): DecoderInfo {
  return decoder.decoderInfo();
}

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
  upgrade: string;
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
  return readTransactionWithId(txHex, viewingKey).outputs;
}

/** Same as readTransaction, plus the transaction id computed from the bytes. */
export function readTransactionWithId(txHex: string, viewingKey: string): { txid: string; outputs: ReadOutput[] } {
  const result = decoder.decryptTx(txHex, viewingKey);
  const outputs: ReadOutput[] = [];
  for (const pool of ["orchard", "ironwood", "sapling"] as const) {
    for (const o of result[pool]) {
      outputs.push({ pool, amountZat: o.amountZat, memo: o.memo, transferType: o.transferType });
    }
  }
  return { txid: result.txid, outputs };
}
