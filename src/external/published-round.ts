// Reads a sealed-bid round published by another Zcash auction project (format credited in THIRD_PARTY.md), and recomputes it.
// It uses only the numbers inside the published file. It opens no network connection and never
// looks at the chain, so it can say "these numbers add up" but not "these amounts are what was paid".
// That format prices a lot at the lowest winning bid, which differs from imani's rule, so this file
// applies the format's own stated rule and does not use rules.ts.

export class ExternalRoundInputError extends Error {}

export type ExternalRoundKind = "settlement" | "reveal";
export type LineStatus = "PASS" | "FAIL";

export interface ExternalRoundLine {
  id: string;
  title: string;
  status: LineStatus;
  /** One plain sentence. */
  detail: string;
}

export interface ExternalRoundReport {
  tool: "imani external round";
  kind: ExternalRoundKind;
  lot: string;
  result: LineStatus;
  lines: ExternalRoundLine[];
  /** What this reading does not cover, in plain words. */
  limits: string[];
  /** Facts worth knowing that are not a pass or a fail. */
  notes: string[];
  serversContacted: string[];
}

interface Round {
  kind: ExternalRoundKind;
  lot: string;
  reserveZat: number;
  slots: number;
  clearingZat: number;
  bids: { id: string; amountZat: number; won: boolean; label: string }[];
  /** Settlement files: what each row says it pays and gets back. */
  rows?: { id: string; label: string; paysZat: number; refundZat: number }[];
  /** Settlement files: the totals the file states. */
  totals?: { bids: number; payout: number; refund: number; received: number; escrow: number };
  /** Reveal files: refund list. A null amount means the file does not state one. */
  refunds?: { id: string; amountZat: number | null; kind: string }[];
}

const zat = (v: unknown, what: string): number => {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+(\.\d{1,8})?$/.test(s)) throw new ExternalRoundInputError(`The ${what} is not a ZEC amount: ${JSON.stringify(v)}.`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 1e8 + Number(frac.padEnd(8, "0"));
};
const zec = (z: number) => {
  const s = (z / 1e8).toFixed(8).replace(/0+$/, "");
  return s.endsWith(".") ? s + "0" : s;
};
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ExternalRoundInputError(`The ${what} is not a whole number.`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new ExternalRoundInputError(`The ${what} is missing.`);
  return v;
};
const arr = (v: unknown, what: string): any[] => {
  if (!Array.isArray(v)) throw new ExternalRoundInputError(`The ${what} list is missing.`);
  return v;
};

/** Which kind of published round file this is, or null when it is neither. */
export function detectExternalRound(x: unknown): ExternalRoundKind | null {
  const o = x as any;
  if (o && o.protocol === "SHIELDBID/1" && Array.isArray(o.settlement)) return "settlement";
  if (o && o.schema === "shieldbid/reveal/1" && Array.isArray(o.received)) return "reveal";
  return null;
}

function readRound(x: unknown): Round {
  const kind = detectExternalRound(x);
  const o = x as any;
  if (kind === "settlement") {
    const rows = arr(o.settlement, "settlement").map((r, i) => {
      const id = str(r?.txid, `settlement row ${i + 1} txid`);
      return { id, label: String(r.bidder ?? `row ${i + 1}`), amountZat: zat(r.amount, `row ${i + 1} amount`), won: r.result === "win", paysZat: zat(r.pays, `row ${i + 1} pays`), refundZat: zat(r.refund, `row ${i + 1} refund`) };
    });
    return {
      kind,
      lot: str(o.auction_id, "auction id"),
      reserveZat: zat(o.reserve, "reserve"),
      slots: int(o.slots, "slot count"),
      clearingZat: zat(o.clearing_price, "clearing price"),
      bids: rows.map((r) => ({ id: r.id, amountZat: r.amountZat, won: r.won, label: r.label })),
      rows: rows.map((r) => ({ id: r.id, label: r.label, paysZat: r.paysZat, refundZat: r.refundZat })),
      totals: {
        bids: zat(o.escrow_bids_total, "bid total"),
        payout: zat(o.payout_to_seller, "payout"),
        refund: zat(o.total_refund, "total refund"),
        received: int(o.bids_received, "bids received"),
        escrow: zat(o.escrow_in_lot_wallet, "escrow in the lot wallet"),
      },
    };
  }
  if (kind === "reveal") {
    const received = arr(o.received, "received").map((r, i) => ({
      id: str(r?.txid, `received row ${i + 1} txid`),
      amountZat: zat(r.amount_zec, `received row ${i + 1} amount`),
      won: r.status === "winner",
      label: `bid ${i + 1}`,
    }));
    return {
      kind,
      lot: str(o.lot, "lot name"),
      reserveZat: zat(o.reserve_zec, "reserve"),
      slots: int(o.winners, "winner count"),
      clearingZat: zat(o.clearing_zec, "clearing price"),
      bids: received,
      refunds: arr(o.refunds, "refunds").map((r, i) => ({
        id: str(r?.txid, `refund ${i + 1} txid`),
        amountZat: r.amount_zec === null || r.amount_zec === undefined ? null : zat(r.amount_zec, `refund ${i + 1} amount`),
        kind: String(r.kind ?? ""),
      })),
    };
  }
  throw new ExternalRoundInputError("This is not a reveal file or settlement file in a format imani reads.");
}

const line = (id: string, title: string, ok: boolean, pass: string, fail: string): ExternalRoundLine => ({ id, title, status: ok ? "PASS" : "FAIL", detail: ok ? pass : fail });

/** Recompute a published round from the numbers in its published file. */
export function checkExternalRound(file: unknown): ExternalRoundReport {
  const r = readRound(file);
  const lines: ExternalRoundLine[] = [];
  const notes: string[] = [];
  const winners = r.bids.filter((b) => b.won);
  const losers = r.bids.filter((b) => !b.won);
  const eligible = r.bids.filter((b) => b.amountZat >= r.reserveZat);
  const lowestWinner = winners.length ? Math.min(...winners.map((b) => b.amountZat)) : 0;
  const ids = r.bids.map((b) => b.id);

  lines.push(line("no-duplicates", "Every bid is listed once", new Set(ids).size === ids.length, `${ids.length} bids, no transaction id repeated.`, "A transaction id is listed more than once."));

  const expectedWinners = Math.min(r.slots, eligible.length);
  const highestLoser = losers.length ? Math.max(...losers.map((b) => b.amountZat)) : 0;
  const winnersOk = winners.length === expectedWinners && winners.every((b) => b.amountZat >= r.reserveZat) && (winners.length === 0 || losers.every((b) => b.amountZat <= lowestWinner));
  lines.push(
    line(
      "winners-are-highest",
      "The winners are the highest bids at or above the reserve",
      winnersOk,
      `${winners.length} of ${r.slots} items sold, to the ${winners.length} highest eligible bids.`,
      winners.some((b) => b.amountZat < r.reserveZat)
        ? "A winner bid less than the reserve."
        : winners.length !== expectedWinners
          ? `${winners.length} winners are listed but ${expectedWinners} are expected.`
          : `A losing bid (${zec(highestLoser)} ZEC) is higher than the lowest winning bid (${zec(lowestWinner)} ZEC).`,
    ),
  );

  lines.push(
    line("clearing-price", "The price is the lowest winning bid", r.clearingZat === lowestWinner, `The stated price ${zec(r.clearingZat)} ZEC equals the lowest winning bid.`, `The stated price is ${zec(r.clearingZat)} ZEC but the lowest winning bid is ${zec(lowestWinner)} ZEC.`),
  );

  if (r.kind === "settlement") {
    const rows = r.rows!;
    const t = r.totals!;
    const badRows: string[] = [];
    for (const row of rows) {
      const bid = r.bids.find((b) => b.id === row.id)!;
      const expectPays = bid.won ? r.clearingZat : 0;
      const expectRefund = bid.amountZat - expectPays;
      if (row.paysZat !== expectPays || row.refundZat !== expectRefund) badRows.push(`${row.label} (pays ${zec(row.paysZat)}, refund ${zec(row.refundZat)}; expected ${zec(expectPays)} and ${zec(expectRefund)})`);
    }
    lines.push(line("rows-add-up", "Each row pays and gets back the right amounts", badRows.length === 0, `All ${rows.length} rows: winners pay the price and get the rest back, losers get everything back.`, `Wrong amounts for ${badRows.join("; ")}.`));

    const sumBids = r.bids.reduce((s, b) => s + b.amountZat, 0);
    const payout = winners.length * r.clearingZat;
    const refundSum = r.bids.reduce((s, b) => s + b.amountZat - (b.won ? r.clearingZat : 0), 0);
    const totalsOk = t.bids === sumBids && t.payout === payout && t.refund === refundSum && payout + refundSum === sumBids;
    lines.push(
      line(
        "totals",
        "The stated totals match the rows",
        totalsOk,
        `Bids ${zec(sumBids)}, seller gets ${zec(payout)}, refunds ${zec(refundSum)} ZEC: they add up.`,
        `Stated totals (bids ${zec(t.bids)}, seller ${zec(t.payout)}, refunds ${zec(t.refund)}) differ from the rows (bids ${zec(sumBids)}, seller ${zec(payout)}, refunds ${zec(refundSum)}).`,
      ),
    );
    lines.push(line("bid-count", "The bid count matches the rows", t.received === rows.length, `${rows.length} bids stated and listed.`, `The file states ${t.received} bids but lists ${rows.length}.`));
    if (t.escrow !== t.bids) notes.push(`The file says the lot wallet held ${zec(t.escrow)} ZEC while the bids add up to ${zec(t.bids)} ZEC. The file does not explain the ${zec(Math.abs(t.bids - t.escrow))} ZEC difference, so this reading does not use it.`);
  } else {
    const refunds = r.refunds!;
    const bad: string[] = [];
    const missing: string[] = [];
    for (const b of losers) {
      const refund = refunds.find((x) => x.id === b.id);
      if (!refund) {
        missing.push(b.id.slice(0, 8));
      } else if (refund.amountZat !== null && refund.amountZat !== b.amountZat) {
        bad.push(`${b.id.slice(0, 8)} bid ${zec(b.amountZat)} but refund ${zec(refund.amountZat)}`);
      }
    }
    lines.push(
      line(
        "refund-amounts",
        "Every losing bid is refunded exactly what it paid",
        bad.length === 0 && missing.length === 0,
        `${losers.length} losing bids, each refunded the amount it paid in.`,
        [bad.length ? `Refund and bid disagree: ${bad.join("; ")}.` : "", missing.length ? `No refund listed for ${missing.join(", ")}.` : ""].filter(Boolean).join(" "),
      ),
    );
    const winnerRefunded = refunds.filter((x) => winners.some((w) => w.id === x.id));
    lines.push(line("winners-not-refunded", "No winner is also refunded their whole bid", winnerRefunded.length === 0, "No winning bid appears in the refund list.", `${winnerRefunded.length} winning bid(s) appear in the refund list.`));
    if (winners.some((w) => w.amountZat > r.clearingZat)) notes.push("A winner bid more than the price, and this file format has no place to list that overpayment, so it was not checked.");
  }

  return {
    tool: "imani external round",
    kind: r.kind,
    lot: r.lot,
    result: lines.every((l) => l.status === "PASS") ? "PASS" : "FAIL",
    lines,
    limits: [
      "Not checked: that these amounts are what was really paid on the chain. The file does not carry the transactions, and the lot key is not public.",
      "Not checked: when bid amounts became public, or whether the commitment was published first.",
    ],
    notes,
    serversContacted: [],
  };
}

export function externalRoundText(rep: ExternalRoundReport): string {
  const out = [`Published round ${rep.lot} (${rep.kind} file), recomputed by imani`, "Servers contacted: none", ""];
  for (const l of rep.lines) out.push(`${l.status.padEnd(5)} ${l.title}`, `      ${l.detail}`);
  if (rep.notes.length) out.push("", ...rep.notes.map((n) => `NOTE  ${n}`));
  out.push("", ...rep.limits, "", `RESULT: ${rep.result}`);
  return out.join("\n");
}
