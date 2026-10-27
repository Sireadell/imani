// What the holder of a lot's viewing key can read, block by block. Read only: it never prints the
// key, never talks to a network, and changes no pass/fail rule.
//
// The honest limit: a shielded payment can be read by whoever holds the viewing key for the address
// it was sent to, as soon as it is in a block. So a seller cannot be stopped from reading what
// arrives. A sealed lot makes sure that what arrives before the close carries no price: every
// bidder pays the same deposit and the memo holds only a code of the price.
import { bidMemoPrefix, openMemoPrefix, parseOpenMemo, sealMemoPrefix, type Disclosure } from "./files.ts";
import { readTransactionWithId } from "./read.ts";

export interface SellerSight {
  /** Transaction id, recomputed from the transaction bytes. */
  txid: string;
  height: number;
  /** What the payment carried into the lot, in zatoshis (outputs to the lot added together). */
  paidZat: number;
  kind: "bid" | "seal" | "opening" | "other";
  /**
   * The price the key holder can read from this payment. A plain bid shows its amount, a seal shows
   * nothing (null), a well-formed opening shows the opened price.
   */
  readablePriceZat: number | null;
}

/** Everything the lot key can read in blocks up to and including `height`. */
export function sellerViewAt(d: Disclosure, height: number): SellerSight[] {
  const bid = bidMemoPrefix(d.lotId);
  const seal = sealMemoPrefix(d.lotId);
  const open = openMemoPrefix(d.lotId);
  const out: SellerSight[] = [];
  for (const t of d.transactions) {
    if (t.height > height) continue;
    const read = readTransactionWithId(t.txHex, d.ufvk);
    const byKind = new Map<SellerSight["kind"], { paid: number; memo: string }>();
    for (const o of read.outputs) {
      if (o.transferType !== "incoming") continue;
      const kind: SellerSight["kind"] = o.memo.startsWith(seal) ? "seal" : o.memo.startsWith(open) ? "opening" : o.memo.startsWith(bid) ? "bid" : "other";
      const prev = byKind.get(kind);
      byKind.set(kind, { paid: (prev?.paid ?? 0) + o.amountZat, memo: prev?.memo ?? o.memo });
    }
    for (const [kind, v] of byKind) {
      let price: number | null = null;
      if (kind === "bid") price = v.paid;
      if (kind === "opening") price = parseOpenMemo(d.lotId, v.memo)?.amountZat ?? null;
      out.push({ txid: read.txid, height: t.height, paidZat: v.paid, kind, readablePriceZat: price });
    }
  }
  return out;
}

/** Every price the lot key could show by this block. */
export function pricesReadableAt(d: Disclosure, height: number): { txid: string; priceZat: number }[] {
  return sellerViewAt(d, height)
    .filter((s) => s.readablePriceZat !== null)
    .map((s) => ({ txid: s.txid, priceZat: s.readablePriceZat as number }));
}

/** Openings that arrived at or before the close. Their prices were readable while bidding was open. */
export function earlyOpenings(d: Disclosure): SellerSight[] {
  return sellerViewAt(d, d.closeHeight).filter((s) => s.kind === "opening" && s.readablePriceZat !== null);
}
