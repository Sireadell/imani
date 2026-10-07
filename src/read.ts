import { decrypt_tx } from "@ledgerhq/zcash-decrypt";

export type TransferType = "incoming" | "outgoing" | "internal";

export interface ReadOutput {
  pool: "orchard" | "sapling";
  amountZat: number;
  memo: string;
  transferType: TransferType;
}

/**
 * Read one raw transaction with a viewing key and return every output the key can see.
 * A viewing key is read-only: it can show payments, never spend them.
 */
export function readTransaction(txHex: string, viewingKey: string): ReadOutput[] {
  const result = decrypt_tx(txHex, viewingKey);
  const out: ReadOutput[] = [];
  for (const o of result.orchard_outputs) {
    out.push({ pool: "orchard", amountZat: o.amount, memo: o.memo, transferType: o.transfer_type as TransferType });
  }
  for (const o of result.sapling_outputs) {
    out.push({ pool: "sapling", amountZat: o.amount, memo: o.memo, transferType: o.transfer_type as TransferType });
  }
  return out;
}
