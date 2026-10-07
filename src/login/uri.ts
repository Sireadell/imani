import { b64urlEncode } from "./encoding.ts";
import { addressMatchesNetwork, type Challenge } from "./challenge.ts";
import { MEMO_LIMIT, looksLikeKey } from "./memo.ts";

/** Format zatoshis as a ZIP 321 amount: decimal ZEC, at most 8 fraction digits, no trailing zeros. */
export function formatZec(zat: number): string {
  if (!Number.isSafeInteger(zat) || zat < 0 || zat > 21_000_000 * 1e8) throw new Error("Amount out of range.");
  const whole = Math.floor(zat / 1e8);
  const frac = String(zat % 1e8).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Build the payment link (ZIP 321) a wallet opens to send the login payment:
 *   zcash:<site address>?amount=<ZEC>&memo=<base64url memo>
 * It always pays exactly one address, with no indexed parameters, so a wallet cannot be
 * steered into paying a hidden second payee. The link carries the signed login memo by design;
 * it is handed to the user's wallet (QR code or tap), never sent to a web server.
 */
export function buildPaymentUri(challenge: Pick<Challenge, "siteAddress" | "network" | "minZat">, memo: string): string {
  if (!addressMatchesNetwork(challenge.siteAddress, challenge.network)) throw new Error("Site address belongs to the other network.");
  if (!/^[a-z0-9]+$/.test(challenge.siteAddress)) throw new Error("Site address is not valid.");
  const bytes = Buffer.from(memo, "utf8");
  if (bytes.length > MEMO_LIMIT) throw new Error("Memo is longer than 512 bytes.");
  if (looksLikeKey(memo)) throw new Error("Refusing to put something shaped like a Zcash key into a memo.");
  return `zcash:${challenge.siteAddress}?amount=${formatZec(challenge.minZat)}&memo=${b64urlEncode(bytes)}`;
}

export type PayeeCheck = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Read a zcash: link and refuse it unless it pays exactly one address.
 * Follows ZIP 321: no repeated parameters, unknown "req-" parameters make the link invalid,
 * and any indexed parameter (address.1, amount.1, ...) means a second payment, which a login never needs.
 */
export function checkSinglePayee(uri: string): PayeeCheck {
  if (!uri.startsWith("zcash:")) return { ok: false, reason: "not a zcash: link" };
  const rest = uri.slice("zcash:".length);
  const q = rest.indexOf("?");
  const address = q === -1 ? rest : rest.slice(0, q);
  const params = q === -1 ? [] : rest.slice(q + 1).split("&");
  if (!/^[A-Za-z0-9]+$/.test(address)) return { ok: false, reason: "the link has no single payee address" };
  const seen = new Set<string>();
  for (const p of params) {
    const name = p.split("=")[0];
    if (seen.has(name)) return { ok: false, reason: `parameter "${name}" appears twice` };
    seen.add(name);
    if (name === "address" || /\.[0-9]+$/.test(name)) return { ok: false, reason: "the link pays more than one address" };
    if (name.startsWith("req-")) return { ok: false, reason: `unknown required parameter "${name}"` };
  }
  return { ok: true, address };
}
