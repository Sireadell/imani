/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript entry point: `decoderInfo()` returns
 * `{ decoder, librustzcash: {crate: version}, highestUpgrade, highestBranchId,
 *    transactionVersions, upgrades: [{ name, branchId, activationHeight: { main, test } }] }`.
 */
export function decoderInfo(): any;

/**
 * JavaScript entry point: `decryptTx(txHex, ufvk)` returns
 * `{ txid, txVersion, branchId, upgrade, shape, orchard: [...], ironwood: [...], sapling: [...] }`.
 * `shape` counts the public parts (transparent inputs and outputs, Sapling spends and
 * outputs, Orchard and Ironwood actions).
 * Each output is `{ index, amountZat, memo, memoHex, transferType }`.
 * Throws an Error with a readable message on a bad key or a bad transaction.
 * A transaction from a network upgrade this build does not know throws
 * "unsupported network upgrade 0x...".
 */
export function decryptTx(tx_hex: string, ufvk: string): any;
