// Browser version of src/read.ts. The build swaps this file in for src/read.ts.
// It reads transactions with the same WebAssembly decoder (vendor/decoder/imani_decoder_bg.wasm),
// whose bytes are embedded in the page, so nothing is downloaded after the page loads.
import * as glue from "imani-decoder-glue";

export type { DecoderInfo, TransferType, Pool, ReadOutput } from "../read.ts";
import type { DecoderInfo, ReadOutput } from "../read.ts";

let ready = false;

/** Start the decoder. Call and await once before reading any transaction. */
export async function initReader(): Promise<void> {
  if (ready) return;
  await glue.initGlue();
  ready = true;
}

/** The exact decoder bytes this page runs, for showing their hash. */
export function decoderBytes(): Uint8Array {
  return glue.wasmBytes();
}

export function decoderInfo(): DecoderInfo {
  return glue.decoderInfo();
}

export function readTransaction(txHex: string, viewingKey: string): ReadOutput[] {
  return readTransactionWithId(txHex, viewingKey).outputs;
}

export function readTransactionWithId(txHex: string, viewingKey: string): { txid: string; outputs: ReadOutput[] } {
  if (!ready) throw new Error("The reader is not started yet.");
  const result = glue.decryptTx(txHex, viewingKey);
  const outputs: ReadOutput[] = [];
  for (const pool of ["orchard", "ironwood", "sapling"] as const) {
    for (const o of result[pool]) {
      outputs.push({ pool, amountZat: o.amountZat, memo: o.memo, transferType: o.transferType });
    }
  }
  return { txid: result.txid, outputs };
}
