// Re-checks one sealed-reveal lot of another Zcash auction project, Blind Bazaar (credited in THIRD_PARTY.md).
// That project publishes the lot's read-only viewing key, its bids' reveals and its result. This reads the
// lot's real blocks with that key and recomputes the outcome from the chain: which payments came in, whether
// each reveal opens a commitment, who wins and at what price. It opens no network connection.
// It applies that project's own rule (first price, commitment = sha256("<lot>|<bid in zatoshis>|<salt>")), so it
// lives in its own file and does not use rules.ts.
import { createHash } from "node:crypto";
import { readTransactionWithId } from "../read.ts";
import type { ChainFile } from "../scan/chain.ts";

export class BlindBazaarInputError extends Error {}

export interface BlindBazaarLot {
  id: string;
  format: string;
  units: number;
  reserve_zats: number;
  deposit_zats: number;
  close_height: number;
  audit_birthday: number;
}
export interface BlindBazaarResult {
  auction_id: string;
  clearing_zats: number;
  winning_txid: string;
  audit: { ufvk: string; birthday: number; reveals: { bid_zats: number; salt: string }[] };
}

export interface BlindBazaarLine {
  id: string;
  title: string;
  status: "PASS" | "FAIL";
  detail: string;
}
export interface BlindBazaarReport {
  tool: "imani external lot";
  lot: string;
  result: "PASS" | "FAIL";
  lines: BlindBazaarLine[];
  payments: { txid: string; height: number; amountZat: number; commitment: string }[];
  limits: string[];
}

const hex64 = /^[0-9a-f]{64}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function need(ok: boolean, what: string): void {
  if (!ok) throw new BlindBazaarInputError(what);
}

export function checkBlindBazaarLot(lot: BlindBazaarLot, res: BlindBazaarResult, chain: ChainFile): BlindBazaarReport {
  need(lot?.format === "first_price" && lot.units === 1, "This reader handles one-item first-price lots only.");
  need(Number.isSafeInteger(lot.deposit_zats) && Number.isSafeInteger(lot.reserve_zats) && Number.isSafeInteger(lot.close_height), "lot.json is missing the deposit, reserve or close height.");
  need(typeof res?.audit?.ufvk === "string" && Array.isArray(res.audit.reveals), "result.json has no published viewing key or reveals.");
  need(chain?.format === "imani-chain/1" && chain.network === "test" && Array.isArray(chain.blocks), "That is not a test-network block file.");
  const heights = new Set(chain.blocks.map((b) => b.height));
  const missing: number[] = [];
  for (let h = lot.audit_birthday; h <= lot.close_height; h++) if (!heights.has(h)) missing.push(h);

  // Every payment the lot key sees that carries a commitment memo for this lot.
  const payments: BlindBazaarReport["payments"] = [];
  let otherIncoming = 0;
  for (const b of chain.blocks) {
    for (const t of b.txs) {
      const read = readTransactionWithId(t.txHex, res.audit.ufvk);
      for (const o of read.outputs) {
        if (o.transferType !== "incoming") continue;
        const m = /^BB1C\|([^|]+)\|([0-9a-f]{64})\|/.exec(o.memo ?? "");
        if (m && m[1] === lot.id) payments.push({ txid: read.txid, height: b.height, amountZat: o.amountZat, commitment: m[2] });
        else otherIncoming++;
      }
    }
  }
  const onTime = payments.filter((p) => p.height <= lot.close_height);
  const late = payments.length - onTime.length;
  const lines: BlindBazaarLine[] = [];
  const add = (id: string, title: string, ok: boolean, passText: string, failText: string) => lines.push({ id, title, status: ok ? "PASS" : "FAIL", detail: ok ? passText : failText });

  add("blocks-read", "Every block from the lot's birthday to its close was read", missing.length === 0, `Blocks ${lot.audit_birthday} to ${lot.close_height} are all in the block file.`, `Blocks missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}.`);
  add("bids-found", "The lot key shows the bids", onTime.length > 0 && otherIncoming === 0, `The published key shows ${payments.length} commitment payment(s) for lot ${lot.id} and no other incoming payment.`, otherIncoming ? `${otherIncoming} incoming payment(s) are not commitments for this lot.` : "The key shows no commitment payment for this lot.");
  add("deposits", "Every bid paid the deposit", onTime.length > 0 && onTime.every((p) => p.amountZat === lot.deposit_zats), `${onTime.length} payment(s) of exactly ${lot.deposit_zats.toLocaleString("en-US")} zat.`, `Deposits read from the chain: ${onTime.map((p) => p.amountZat).join(", ")}; the lot asks ${lot.deposit_zats}.`);
  add("on-time", "No bid arrived after the close", late === 0, `All ${payments.length} payment(s) are in blocks up to the close at ${lot.close_height}.`, `${late} payment(s) arrived after block ${lot.close_height}.`);

  // Reveals: each must open exactly one commitment found on the chain.
  const used = new Set<string>();
  const opened: { txid: string; bidZat: number }[] = [];
  const badReveals: string[] = [];
  for (const r of res.audit.reveals) {
    const h = sha256(`${lot.id}|${r.bid_zats}|${r.salt}`);
    const p = onTime.find((x) => x.commitment === h && !used.has(h));
    if (p) {
      used.add(h);
      opened.push({ txid: p.txid, bidZat: r.bid_zats });
    } else badReveals.push(String(r.bid_zats));
  }
  add("reveals-open-commitments", "Every reveal opens a commitment paid on the chain", badReveals.length === 0 && opened.length > 0, `${opened.length} reveal(s) hash to the commitments in the payments' memos.`, `No on-chain commitment matches the reveal of ${badReveals.join(", ")}.`);

  const valid = opened.filter((o) => o.bidZat >= lot.reserve_zats).sort((a, b) => b.bidZat - a.bidZat || (a.txid < b.txid ? -1 : 1));
  const tie = valid.length > 1 && valid[0].bidZat === valid[1].bidZat;
  const win = valid[0];
  const claimOk = !!win && !tie && hex64.test(res.winning_txid) && win.txid === res.winning_txid && win.bidZat === res.clearing_zats;
  add(
    "winner-and-price",
    "Winner and price follow first-price rules",
    claimOk,
    `The highest revealed bid at or above the reserve (${lot.reserve_zats.toLocaleString("en-US")} zat) is ${win?.bidZat.toLocaleString("en-US")} zat in ${win?.txid.slice(0, 10)}; the winner pays their own bid, as published.`,
    !win ? "No revealed bid reaches the reserve." : tie ? "Two bids tie for the top and this reader has no tie rule." : `The chain gives winner ${win.txid.slice(0, 10)} at ${win.bidZat} zat; the result says ${String(res.winning_txid).slice(0, 10)} at ${res.clearing_zats}.`,
  );
  return {
    tool: "imani external lot",
    lot: lot.id,
    result: lines.every((l) => l.status === "PASS") ? "PASS" : "FAIL",
    lines,
    payments,
    limits: [
      "Refunds, the sweep and the payout are paid from the operator's own wallet, which the lot key cannot see, so they are not checked here.",
      "A bid that was paid but never revealed cannot win under this project's rules; this reader counts it as a payment but gives it no price.",
      "This applies the other project's own rules as published. Imani does not run, host or judge that project.",
    ],
  };
}

export function blindBazaarText(rep: BlindBazaarReport): string {
  const out = [`Lot ${rep.lot} (Zcash test network), re-read from the chain with the viewing key the project published`, ""];
  for (const l of rep.lines) out.push(`${l.status}  ${l.title}`, `      ${l.detail}`);
  out.push("", ...rep.payments.map((p) => `  ${p.txid.slice(0, 10)}  block ${p.height}  ${p.amountZat.toLocaleString("en-US")} zat  commitment ${p.commitment.slice(0, 10)}`));
  out.push("", ...rep.limits.map((l) => `Not covered: ${l}`), "Servers contacted: none (read from the saved block file).", "", `RESULT: ${rep.result} (${rep.lines.filter((l) => l.status === "PASS").length} of ${rep.lines.length} checks passed)`);
  return out.join("\n");
}
