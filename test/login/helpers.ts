import { createHash } from "node:crypto";
import { AccountKey } from "../../src/login/key.ts";
import type { TxReader } from "../../src/login/verify.ts";
import type { ReadOutput } from "../../src/read.ts";

export const SITE = "shop.example";
export const T0 = 1_790_000_000;
// Shaped like real keys and addresses; only used with the fake reader below.
export const FAKE_UFVK = "uviewtest1" + "q".repeat(300);
export const FAKE_ADDRESS = "utest1" + "p".repeat(200);

export function fixedRandom(label: string) {
  let counter = 0;
  return (n: number) => {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const h = createHash("sha256").update(`${label}:${counter++}`).digest();
      off += h.copy(out, off);
    }
    return out;
  };
}

export function fixedKey(label: string): AccountKey {
  return AccountKey.fromSeed(createHash("sha256").update(`imani login test account: ${label}`).digest());
}

/** A fake transaction: the hex string is a lookup key into a table of outputs. */
export function fakeChain() {
  const table = new Map<string, ReadOutput[]>();
  let n = 0;
  const readTx: TxReader = (txHex) => {
    const outputs = table.get(txHex);
    if (!outputs) throw new Error("unknown fake transaction");
    return { txid: "fake" + txHex, outputs };
  };
  const pay = (memo: string, amountZat = 10_000, transferType: ReadOutput["transferType"] = "incoming"): string => {
    const hex = (++n).toString(16).padStart(8, "0");
    table.set(hex, [{ pool: "ironwood", amountZat, memo, transferType }]);
    return hex;
  };
  const raw = (outputs: ReadOutput[]): string => {
    const hex = (++n).toString(16).padStart(8, "0");
    table.set(hex, outputs);
    return hex;
  };
  return { readTx, pay, raw };
}
