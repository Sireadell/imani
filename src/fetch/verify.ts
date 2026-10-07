import { createRequire } from "node:module";

// The txid check uses the same prebuilt librustzcash decoder as src/read.ts. librustzcash
// parses the transaction and computes its id: double SHA-256 for v4, the ZIP-244 digest
// for v5 and v6. No hand-written hash code is involved.
const require = createRequire(import.meta.url);
const decoder = require("../../vendor/decoder/imani_decoder.js") as {
  decryptTx(txHex: string, ufvk: string): { txid: string; txVersion: number; branchId: string };
};

// The decoder's only entry point also wants a viewing key. To compute a txid we pass this
// fixed key: the public "stranger" key from test/vectors/offline-vectors.json, made from a
// throwaway test seed that has never held money. It never leaves this process and is never
// sent to any server. Its decrypted outputs are ignored; only the txid is used.
const TXID_ONLY_KEY =
  "uviewtest1q2ejsw2g7cp5zw0wuprqpgqhcsfdmw3wmxl5nh968epjml0v0hhpgtkufzmctmu0vupl33ys0u2gyfv77gtyq94xgv9dl05ul9d4m9kat80h3vg4rv7jrtx4q7wlcewvlwv4eh3jdsv9e9g5qjwv4czhsujkndnwpzqlrvafddnln04xg685d7zn488gwxc8h92av23n7hrgzknn9s3sptvdryw2mll5e0uw9gzjrk6vn7zn8jpcmq3xm20lfm2hcfstvm0g57w9y6e0d8759cuyhqqkkt7wmtp77tnxz5e4z3zspjct0y6lss6r8sxnp4u482aqfurg7y5ye7q3et06w2uevfx6xgqzjye9s7cf6497r93jcfefy3atsh242gvngrkssumxzxzvuctc4updgdlt235n8ctskpg9lnvm4h9pazrajs9chyqgzyf0y2f9ytnqkrry7ujs8kkdkj6gy4lc24qd9pqagqqqqj34ghzgrvmsnhtm";

export const TXID_RE = /^[0-9a-f]{64}$/;

/**
 * Computes the txid (display hex, as explorers show it) of a raw transaction.
 * Throws if librustzcash cannot parse the bytes, for example an unknown transaction
 * version or network upgrade. Callers must treat a throw as "not verified".
 */
export function computeTxid(txHex: string): { txid: string; txVersion: number; branchId: string } {
  if (!/^(?:[0-9a-f]{2})+$/i.test(txHex)) throw new Error("transaction is not hex");
  const r = decoder.decryptTx(txHex, TXID_ONLY_KEY);
  if (!TXID_RE.test(r.txid)) throw new Error("decoder returned no txid");
  return { txid: r.txid, txVersion: r.txVersion, branchId: r.branchId };
}

function idOrNull(txHex: string): string | null {
  try {
    return computeTxid(txHex).txid;
  } catch {
    return null;
  }
}

/**
 * Checks raw bytes against an expected txid. Returns null when they match exactly, or a
 * short reason when they do not.
 *
 * The decoder reads a transaction from the front and ignores anything after its end, so
 * bytes with junk appended would still give the right txid. To catch that we also drop
 * the last byte: an exact transaction can no longer be read without it, while one with
 * junk on the end still reads as the same transaction.
 */
export function checkTxBytes(txHex: string, expectedTxid: string): string | null {
  const want = expectedTxid.toLowerCase();
  let got: string;
  try {
    got = computeTxid(txHex).txid;
  } catch (e) {
    return `could not read the transaction (${(e as Error).message})`;
  }
  if (got !== want) return `bytes hash to a different txid ${got}`;
  if (idOrNull(txHex.slice(0, -2)) === want) return "extra bytes after the end of the transaction";
  return null;
}
