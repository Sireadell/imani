import type { AccountKey } from "./key.ts";
import { NONCE_PATTERN, SITE_ID_PATTERN, type Challenge, type Network } from "./challenge.ts";

/** First line of every login memo. A new format gets a new number; old parsers then refuse it. */
export const MEMO_TAG = "imani-login:1";
/** Zcash memo field size in bytes. */
export const MEMO_LIMIT = 512;

export interface LoginMemo {
  siteId: string;
  network: Network;
  nonce: string;
  expiresAt: number;
  /** Account id: the site key's Ed25519 public key, base64url, 43 characters. */
  accountId: string;
  /** Ed25519 signature over signedText(...), base64url, 86 characters. */
  signature: string;
}

/**
 * The exact text the account key signs: the memo without its last line.
 * It covers the format tag, site id, network, one-time code, expiry and account id.
 */
export function signedText(m: Omit<LoginMemo, "signature">): string {
  return [MEMO_TAG, `site:${m.siteId}`, `net:${m.network}`, `code:${m.nonce}`, `exp:${m.expiresAt}`, `key:${m.accountId}`].join("\n");
}

export function formatMemo(m: LoginMemo): string {
  return `${signedText(m)}\nsig:${m.signature}`;
}

/**
 * Build the login memo for one challenge. Runs on the user's side; the account key never leaves it.
 * The result is plain text, well under the 512-byte memo limit (about 220 bytes for a short site id).
 */
export function buildLoginMemo(accountKey: AccountKey, challenge: Pick<Challenge, "siteId" | "network" | "nonce" | "expiresAt">): string {
  if (!SITE_ID_PATTERN.test(challenge.siteId)) throw new Error("Site id in the login code is not valid.");
  if (!NONCE_PATTERN.test(challenge.nonce)) throw new Error("Login code is not valid.");
  if (challenge.network !== "main" && challenge.network !== "test") throw new Error("Network in the login code is not valid.");
  if (!Number.isInteger(challenge.expiresAt) || challenge.expiresAt <= 0) throw new Error("Expiry in the login code is not valid.");
  const siteKey = accountKey.siteKey(challenge.siteId);
  const body = {
    siteId: challenge.siteId,
    network: challenge.network,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    accountId: siteKey.publicKey,
  };
  const memo = formatMemo({ ...body, signature: siteKey.sign(signedText(body)) });
  if (Buffer.byteLength(memo, "utf8") > MEMO_LIMIT) throw new Error("Login memo would be longer than 512 bytes; use a shorter site id.");
  if (looksLikeKey(memo)) throw new Error("Refusing to put something shaped like a Zcash key into a memo.");
  return memo;
}

/** First line of the text a login proof signs. A different tag from the memo, so one signature can never pass for the other. */
export const PROOF_TAG = "imani-login-proof:1";

/** The exact text the account key signs for a login proof: tag, site id and one-time code. */
export function proofText(siteId: string, nonce: string): string {
  return [PROOF_TAG, `site:${siteId}`, `code:${nonce}`].join("\n");
}

/**
 * Build the login proof for one challenge. Runs on the user's side, like the memo.
 * Unlike the memo, the proof never goes into the payment link, the QR code or the payment. The page sends it
 * to the site together with the transaction, so someone who only saw the link cannot make it.
 */
export function buildLoginProof(accountKey: AccountKey, challenge: Pick<Challenge, "siteId" | "nonce">): string {
  if (!SITE_ID_PATTERN.test(challenge.siteId)) throw new Error("Site id in the login code is not valid.");
  if (!NONCE_PATTERN.test(challenge.nonce)) throw new Error("Login code is not valid.");
  return accountKey.siteKey(challenge.siteId).sign(proofText(challenge.siteId, challenge.nonce));
}

export type ParseResult = { ok: true; memo: LoginMemo } | { ok: false; reason: "not_a_login_memo" | "memo_malformed" | "memo_too_long" };

const LINE_RULES: [string, RegExp][] = [
  ["site", SITE_ID_PATTERN],
  ["net", /^(main|test)$/],
  ["code", NONCE_PATTERN],
  ["exp", /^[1-9][0-9]{0,11}$/],
  ["key", /^[A-Za-z0-9_-]{43}$/],
  ["sig", /^[A-Za-z0-9_-]{86}$/],
];

/** Strict parser: exact line order, exact names, no extra lines, no spaces. Trailing zero bytes are ignored. */
export function parseLoginMemo(text: string): ParseResult {
  const t = text.replace(/\u0000+$/, "");
  if (Buffer.byteLength(t, "utf8") > MEMO_LIMIT) return { ok: false, reason: "memo_too_long" };
  const lines = t.split("\n");
  if (lines[0] !== MEMO_TAG) return { ok: false, reason: "not_a_login_memo" };
  if (lines.length !== 1 + LINE_RULES.length) return { ok: false, reason: "memo_malformed" };
  const values: string[] = [];
  for (let i = 0; i < LINE_RULES.length; i++) {
    const [name, rule] = LINE_RULES[i];
    const line = lines[i + 1];
    if (!line.startsWith(`${name}:`)) return { ok: false, reason: "memo_malformed" };
    const value = line.slice(name.length + 1);
    if (!rule.test(value)) return { ok: false, reason: "memo_malformed" };
    values.push(value);
  }
  const [siteId, network, nonce, exp, accountId, signature] = values;
  return { ok: true, memo: { siteId, network: network as Network, nonce, expiresAt: Number(exp), accountId, signature } };
}

/**
 * True when text holds something shaped like a Zcash viewing or spending key (bech32 form).
 * A past wallet bug leaked viewing keys inside memos, so the kit refuses to write one.
 */
export function looksLikeKey(text: string): boolean {
  return /(uviewtest|uview|uivktest|uivk|zxviewtestsapling|zxviews|zxview|secret-extended-key-[a-z]+|zivk|zxsk)1[02-9ac-hj-np-z]{40,}/.test(text);
}
