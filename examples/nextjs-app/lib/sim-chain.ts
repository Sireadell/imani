// A pretend Zcash network for this example, so it runs with no wallet and no money. In a real
// site you delete this file: the wallet pays the site address for real, and your server reads
// the real transaction with the site's viewing key (see the imani login docs).
import { randomBytes } from "node:crypto";
import { checkSinglePayee } from "imani/login";
import party from "./sim-party.json";

export const SIM_PREFIX = Buffer.from("imani-simulated-tx:", "utf8").toString("hex");

type Out = { to: string; amountZat: number; memo: string };
const g = globalThis as unknown as { __simTxs?: Map<string, Out[]> };
const txs: Map<string, Out[]> = (g.__simTxs ??= new Map());

/** Read a payment link the way a wallet would: one payee, a ZEC amount, a base64url memo. */
export function parseLink(uri: string): Out {
  if (typeof uri !== "string" || uri.length > 2000) throw new Error("The wallet could not read this payment link.");
  const single = checkSinglePayee(uri);
  if (!single.ok) throw new Error(`The wallet refused this payment link: ${single.reason}.`);
  const q = uri.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : uri.slice(q + 1).replace(/\+/g, "%2B"));
  const m = /^([0-9]{1,8})(?:\.([0-9]{1,8}))?$/.exec(params.get("amount") ?? "");
  if (!m) throw new Error("The wallet refused this payment link: the amount is missing.");
  const memoB64 = params.get("memo") ?? "";
  if (!/^[A-Za-z0-9_-]*$/.test(memoB64)) throw new Error("The wallet refused this payment link: the memo is not base64url.");
  const memo = Buffer.from(memoB64, "base64url");
  if (memo.length > 512) throw new Error("The wallet refused this payment link: the memo is longer than 512 bytes.");
  return { to: single.address, amountZat: Number(m[1]) * 1e8 + Number((m[2] ?? "").padEnd(8, "0")), memo: memo.toString("utf8") };
}

/** The pretend wallet sends a payment. Returns what a real server would fetch: the transaction. */
export function send(uri: string): { txHex: string } {
  const p = parseLink(uri);
  if (p.to !== party.address) throw new Error("The pretend network only knows this site's login address.");
  const txid = randomBytes(32).toString("hex");
  txs.set(txid, [p]);
  return { txHex: SIM_PREFIX + Buffer.from(txid, "utf8").toString("hex") };
}

/** Reader for the login kit. Like a real viewing key, it shows only payments to the site's address. */
export function simReader() {
  return (txHex: string, viewingKey: string) => {
    if (typeof txHex !== "string" || !txHex.startsWith(SIM_PREFIX)) throw new Error("not a simulated transaction");
    const txid = Buffer.from(txHex.slice(SIM_PREFIX.length), "hex").toString("utf8");
    const outs = txs.get(txid);
    if (!outs || !viewingKey) throw new Error("unknown simulated transaction");
    return {
      txid,
      outputs: outs
        .filter((o: Out) => o.to === party.address)
        .map((o: Out) => ({ pool: "orchard" as const, amountZat: o.amountZat, memo: o.memo, transferType: "incoming" as const, recipientHex: "" })),
    };
  };
}
