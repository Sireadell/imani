/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript entry point: `decryptTx(txHex, ufvk)` returns
 * `{ txid, txVersion, branchId, orchard: [...], ironwood: [...], sapling: [...] }`.
 * Each output is `{ index, amountZat, memo, memoHex, transferType }`.
 * Throws an Error with a readable message on a bad key or a bad transaction.
 */
export function decryptTx(tx_hex: string, ufvk: string): any;
