// Browser side of imani login, written with Web Crypto only (no libraries).
// It follows LOGIN_SPEC.md exactly, so the shop's server checks it with the same kit code.
// The login key lives only in this page's memory. It is never sent, never put in a web
// address, and never written to browser storage.

const enc = new TextEncoder();
// DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key (RFC 8410).
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
export const MEMO_TAG = "imani-login:1";
export const EXPORT_PREFIX = "imani-login-key-1:";
export const EXPORT_WARNING =
  "This text is your login key. Anyone who has it can sign in as you. Keep it offline, " +
  "never paste it into a website or a memo, and keep a copy: if you lose it, the account is lost.";

const subtle = () => globalThis.crypto.subtle;

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  if (b64url(out) !== text) throw new Error("not canonical base64url");
  return out;
}

/** True when this browser can make Ed25519 keys with Web Crypto. */
export async function ed25519Supported() {
  try {
    if (!globalThis.crypto?.subtle) return false;
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8[16] = 1;
    await subtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    return true;
  } catch {
    return false;
  }
}

/** A new login key: 32 random bytes from the browser's own random source. */
export function newLoginKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The one-line backup text. Anyone holding it owns the account. */
export function exportLoginKey(seed) {
  return EXPORT_PREFIX + b64url(seed);
}

/** Read a backup line. The error never repeats the input. */
export function importLoginKey(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(EXPORT_PREFIX)) throw new Error("This is not an imani login key backup.");
  let seed;
  try {
    seed = fromB64url(t.slice(EXPORT_PREFIX.length));
  } catch {
    throw new Error("The login key backup is damaged.");
  }
  if (seed.length !== 32) throw new Error("The login key backup is damaged.");
  return seed;
}

/** This site's signing key: Ed25519 seed = HMAC-SHA256(login key, "imani login site key v1\n" + siteId). */
export async function siteKey(loginKey, siteId) {
  const mac = await subtle().importKey("raw", loginKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const seed = new Uint8Array(await subtle().sign("HMAC", mac, enc.encode(`imani login site key v1\n${siteId}`)));
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, 16);
  const priv = await subtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await subtle().exportKey("jwk", priv);
  seed.fill(0);
  pkcs8.fill(0);
  return { privateKey: priv, accountId: jwk.x };
}

export function signedText(m) {
  return [MEMO_TAG, `site:${m.siteId}`, `net:${m.network}`, `code:${m.nonce}`, `exp:${m.expiresAt}`, `key:${m.accountId}`].join("\n");
}

/** Build the signed login memo for one sign-in code. */
export async function buildLoginMemo(loginKey, challenge) {
  const { privateKey, accountId } = await siteKey(loginKey, challenge.siteId);
  const body = { siteId: challenge.siteId, network: challenge.network, nonce: challenge.nonce, expiresAt: challenge.expiresAt, accountId };
  const text = signedText(body);
  const sig = new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, enc.encode(text)));
  const memo = `${text}\nsig:${b64url(sig)}`;
  if (enc.encode(memo).length > 512) throw new Error("The login memo would be longer than 512 bytes.");
  return { memo, accountId };
}

/**
 * The login proof for one sign-in code: a signature by the site key over the proof text. It goes to the
 * shop together with the payment and is never put in the payment link, so someone who only saw the link
 * cannot make it.
 */
export function proofText(siteId, nonce) {
  return ["imani-login-proof:1", `site:${siteId}`, `code:${nonce}`].join("\n");
}

export async function buildLoginProof(loginKey, challenge) {
  const { privateKey } = await siteKey(loginKey, challenge.siteId);
  return b64url(new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, enc.encode(proofText(challenge.siteId, challenge.nonce)))));
}

/** ZIP 321 amount: decimal ZEC, at most 8 fraction digits, no trailing zeros. */
export function formatZec(zat) {
  if (!Number.isSafeInteger(zat) || zat < 0) throw new Error("Amount out of range.");
  const whole = Math.floor(zat / 1e8);
  const frac = String(zat % 1e8).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Read a ZEC amount typed by a person, for example 0.02. Returns zatoshis or null. */
export function parseZec(text) {
  const m = /^\s*([0-9]{1,8})(?:\.([0-9]{1,8}))?\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  return Number(m[1]) * 1e8 + Number((m[2] ?? "").padEnd(8, "0"));
}

/** Payment link that pays exactly one address: zcash:<address>?amount=<ZEC>&memo=<base64url>. */
export function paymentLink(address, zat, memo) {
  if (!/^[a-z0-9]+$/.test(address)) throw new Error("The address is not valid.");
  return `zcash:${address}?amount=${formatZec(zat)}&memo=${b64url(enc.encode(memo))}`;
}

/** A short random word for a bid memo, from an alphabet with no look-alike letters. */
export function bidWord() {
  const abc = "23456789abcdefghjkmnpqrstuvwxyz";
  const r = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (b) => abc[b % abc.length]).join("");
}
