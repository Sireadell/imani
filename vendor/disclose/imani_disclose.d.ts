/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript: `discloseOutputs(txHex, ufvk)` returns `{ txid, outputs: [{ pool, index,
 * transferType, amountZat, memo, memoHex, recipientHex, eskHex }] }`.
 */
export function discloseOutputs(tx_hex: string, ufvk: string): any;

/**
 * JavaScript: `openOutput(txHex, pool, index, receiverHex, eskHex)` returns `{ txid, pool,
 * index, actions, amountZat, memo, memoHex, recipientHex }`, or throws.
 */
export function openOutput(tx_hex: string, pool: string, index: number, receiver_hex: string, esk_hex: string): any;

/**
 * JavaScript: `orchardAddress(receiverHex, network)` returns the address as text.
 */
export function orchardAddress(receiver_hex: string, network: string): any;
