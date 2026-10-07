// Command line (Node) twin of read-browser.ts, so the page logic can be tested in Node.
// The page build swaps this file for read-browser.ts.
import { readFileSync } from "node:fs";
export { decoderInfo, parseAddress } from "../read.ts";

export async function initReader(): Promise<void> {}

export function decoderBytes(): Uint8Array {
  return readFileSync(new URL("../../vendor/decoder/imani_decoder_bg.wasm", import.meta.url));
}
