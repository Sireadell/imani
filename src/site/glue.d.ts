// Made up by tools/site-build.ts from vendor/decoder/imani_decoder.js. See that file.
declare module "imani-decoder-glue" {
  export function initGlue(): Promise<void>;
  export function wasmBytes(): Uint8Array;
  export function decryptTx(txHex: string, ufvk: string): any;
  export function decoderInfo(): any;
  export function parseAddress(address: string): any;
}
declare module "imani-examples" {
  export interface ExampleEntry {
    id: string;
    group: "real-honest" | "real-tampered" | "honest" | "tampered" | "scan-honest" | "scan-tampered" | "receivers-honest" | "receivers-tampered" | "memo-honest" | "memo-tampered";
    title: string;
    story: string;
    expectedFailingCheck: string | null;
    /** Every check a copy must fail, when a real cheat trips more than one. */
    expectedFailingChecks?: string[];
    /** Payments a reader can look up on a public explorer (real rounds only). */
    explorer?: { label: string; url: string }[];
    disclosure: string;
    result: string;
    chain: string | null;
  }
  export const examples: ExampleEntry[];
  /** Content of each file, by short hash. Identical files are stored once. */
  export const blobs: Record<string, string>;
}
