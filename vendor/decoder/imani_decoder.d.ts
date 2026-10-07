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
 * Each output is `{ index, amountZat, memo, memoHex, transferType, recipientHex }`.
 * `recipientHex` is the 43-byte raw address the note was paid to. For an outgoing output the
 * key's outgoing viewing key recovers it; for an incoming one it is the key's own address.
 * Throws an Error with a readable message on a bad key or a bad transaction.
 * A transaction from a network upgrade this build does not know throws
 * "unsupported network upgrade 0x...".
 */
export function decryptTx(tx_hex: string, ufvk: string): any;

/**
 * JavaScript entry point: `parseAddress(address)` returns `{ network, orchard, sapling }`,
 * where `orchard` (also used for Ironwood) and `sapling` are receiver hex strings or null.
 */
export function parseAddress(addr: string): any;
