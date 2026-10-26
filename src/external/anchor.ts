// Ties a round published by another Zcash auction project to the chain. The published file lists the
// transaction ids of its payments. This asks public servers for those transactions, recomputes each
// id from the bytes it gets back, and requires two servers run by different operators to return the
// same bytes. It cannot read amounts or memos (they are encrypted and the lot's key is not published),
// so it proves the payments exist and when they were mined, not that the file's numbers are right.
import { fetchTransactions, operatorOf, FetchError, type FetchResult, type Network } from "../fetch/index.ts";
import { checkTxBytes, TXID_RE } from "../fetch/verify.ts";
import { ExternalRoundInputError, detectExternalRound } from "./published-round.ts";

export type AnchorStatus = "PASS" | "FAIL";

export interface AnchorLine {
  id: string;
  title: string;
  status: AnchorStatus;
  detail: string;
}

export interface AnchoredTx {
  txid: string;
  height: number | null;
  servers: string[];
  bytes: number;
}

export interface AnchorReport {
  tool: "imani external anchor";
  lot: string;
  network: Network;
  result: AnchorStatus;
  lines: AnchorLine[];
  transactions: AnchoredTx[];
  limits: string[];
  /** "live" when servers were asked now, "recorded" when a saved copy of an earlier fetch was read. */
  source: "live" | "recorded";
  serversContacted: string[];
}

/** A saved copy of one fetch, so the check can run offline later. Every transaction is re-verified on read. */
export interface RecordedChain {
  format: "imani-external-anchor/1";
  network: Network;
  fetchedAt: string;
  transactions: { txid: string; hex: string; height?: number; confirmedBy: string[] }[];
}

type Fetcher = (o: { network: Network; txids: string[] }) => Promise<FetchResult>;

/** The transaction ids a published round file lists, in file order, without repeats. */
export function listedTxids(file: unknown): { lot: string; network: Network; txids: string[] } {
  const kind = detectExternalRound(file);
  const o = file as any;
  if (!kind) throw new ExternalRoundInputError("This is not a reveal file or settlement file in a format imani reads.");
  const net = String(o.network ?? "").toLowerCase();
  const network: Network | null = net === "mainnet" || net === "main" ? "main" : net === "testnet" || net === "test" ? "test" : null;
  if (!network) throw new ExternalRoundInputError('The file does not say which network it ran on ("mainnet" or "testnet"), so there is no chain to look at.');
  const rows: unknown[] = kind === "settlement" ? o.settlement.map((r: any) => r?.txid) : [...o.received.map((r: any) => r?.txid), ...(Array.isArray(o.refunds) ? o.refunds.map((r: any) => r?.txid) : [])];
  const txids: string[] = [];
  for (const t of rows) {
    if (t === null || t === undefined || t === "") continue;
    if (typeof t !== "string" || !TXID_RE.test(t.toLowerCase())) throw new ExternalRoundInputError(`A listed transaction id is not 64 hex characters: ${String(t).slice(0, 40)}`);
    const id = t.toLowerCase();
    if (!txids.includes(id)) txids.push(id);
  }
  if (txids.length === 0) throw new ExternalRoundInputError("The file lists no transaction ids.");
  return { lot: String(o.auction_id ?? o.lot ?? "round"), network, txids };
}

const LIMITS = [
  "Amounts and memos are encrypted. Without the lot's viewing key nobody can read what each payment paid, so this does not check the numbers in the published file.",
];
const SHOWS = "It shows that every listed payment exists on the public chain, that two independent servers returned the same bytes, and which block mined each one.";

function build(lot: string, network: Network, txids: string[], got: { txid: string; hex: string; height?: number; confirmedBy: string[] }[], source: "live" | "recorded", serversContacted: string[]): AnchorReport {
  const byId = new Map(got.map((g) => [g.txid, g]));
  const missing = txids.filter((t) => !byId.has(t));
  const badBytes = got.filter((g) => checkTxBytes(g.hex, g.txid) !== null).map((g) => g.txid);
  const transactions: AnchoredTx[] = txids.filter((t) => byId.has(t)).map((t) => {
    const g = byId.get(t)!;
    return { txid: t, height: g.height ?? null, servers: g.confirmedBy, bytes: g.hex.length / 2 };
  });
  const short = (ids: string[]) => ids.map((t) => t.slice(0, 10)).join(", ");
  const single = transactions.filter((t) => new Set(t.servers.map(operatorOf)).size < 2);
  const unmined = transactions.filter((t) => t.height === null);
  const lines: AnchorLine[] = [
    {
      id: "txids-on-chain",
      title: "Every listed payment is on the chain",
      status: missing.length === 0 && badBytes.length === 0 ? "PASS" : "FAIL",
      detail: missing.length === 0 && badBytes.length === 0 ? `All ${txids.length} listed transactions came back, and each one hashes to the id the file lists.` : `${missing.length ? `Not found: ${short(missing)}. ` : ""}${badBytes.length ? `Bytes do not match the id: ${short(badBytes)}.` : ""}`.trim(),
    },
    {
      id: "two-operators-agree",
      title: "Two independent servers returned the same bytes",
      status: single.length === 0 && transactions.length > 0 ? "PASS" : "FAIL",
      detail: single.length === 0 && transactions.length > 0 ? `Every transaction was confirmed by servers run by at least two different operators.` : `Only one operator confirmed: ${short(single.map((t) => t.txid))}.`,
    },
    {
      id: "mined",
      title: "Every payment was mined in a block",
      status: unmined.length === 0 && transactions.length > 0 ? "PASS" : "FAIL",
      detail: unmined.length === 0 && transactions.length > 0 ? `Blocks: ${[...new Set(transactions.map((t) => t.height))].join(", ")}.` : `No block height reported for ${short(unmined.map((t) => t.txid))}.`,
    },
  ];
  return { tool: "imani external anchor", lot, network, result: lines.every((l) => l.status === "PASS") ? "PASS" : "FAIL", lines, transactions, limits: LIMITS, source, serversContacted };
}

/** Ask public servers for the listed transactions now. */
export async function anchorLive(file: unknown, fetcher: Fetcher = fetchTransactions): Promise<{ report: AnchorReport; recorded: RecordedChain }> {
  const { lot, network, txids } = listedTxids(file);
  let r: FetchResult;
  try {
    r = await fetcher({ network, txids });
  } catch (e) {
    if (e instanceof FetchError) {
      const failed: AnchorReport = { tool: "imani external anchor", lot, network, result: "FAIL", lines: [{ id: "txids-on-chain", title: "Every listed payment is on the chain", status: "FAIL", detail: e.message }], transactions: [], limits: LIMITS, source: "live", serversContacted: e.serversContacted };
      return { report: failed, recorded: { format: "imani-external-anchor/1", network, fetchedAt: new Date().toISOString(), transactions: [] } };
    }
    throw e;
  }
  const got = r.transactions.map((t) => ({ txid: t.txid, hex: t.hex, height: t.height, confirmedBy: t.confirmedBy }));
  return { report: build(lot, network, txids, got, "live", r.serversContacted), recorded: { format: "imani-external-anchor/1", network, fetchedAt: new Date().toISOString(), transactions: got } };
}

/** Read a saved copy of an earlier fetch. Every transaction is hashed again, so a changed byte is caught. */
export function anchorRecorded(file: unknown, saved: RecordedChain): AnchorReport {
  const { lot, network, txids } = listedTxids(file);
  if (!saved || saved.format !== "imani-external-anchor/1" || !Array.isArray(saved.transactions)) throw new ExternalRoundInputError("That is not a saved chain copy in the imani-external-anchor/1 format.");
  if (saved.network !== network) throw new ExternalRoundInputError(`The saved copy is for the ${saved.network} network but the round ran on ${network}.`);
  return build(lot, network, txids, saved.transactions.map((t) => ({ ...t, txid: t.txid.toLowerCase() })), "recorded", []);
}

export function anchorText(rep: AnchorReport): string {
  const out = [`Chain anchor for ${rep.lot} on ${rep.network === "main" ? "the Zcash main network" : "the Zcash test network"}`, ""];
  for (const l of rep.lines) out.push(`${l.status}  ${l.title}`, `      ${l.detail}`);
  out.push("");
  for (const t of rep.transactions) out.push(`  ${t.txid.slice(0, 10)}  block ${t.height ?? "?"}  ${t.bytes} bytes  ${[...new Set(t.servers.map(operatorOf))].join(" + ")}`);
  out.push("", `What this shows: ${SHOWS}`, ...rep.limits.map((l) => `Not covered: ${l}`));
  out.push(rep.source === "live" ? `Servers contacted: ${rep.serversContacted.join(", ") || "none"}` : "Servers contacted: none (read from a saved copy of an earlier fetch).");
  out.push("", `RESULT: ${rep.result}`);
  return out.join("\n");
}
