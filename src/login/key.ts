import { createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";

// DER prefixes that wrap a raw 32-byte Ed25519 seed or public key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Prefix of an exported account key. The string is the whole secret: anyone holding it owns the account. */
export const EXPORT_PREFIX = "imani-login-key-1:";

export const EXPORT_WARNING =
  "This text is your login key. Anyone who has it can sign in as you. Keep it offline, " +
  "never paste it into a website or a memo, and keep a copy: if you lose it, the account is lost.";

/**
 * The user's login key. It is made on the user's device and never sent anywhere.
 * For each site a separate Ed25519 key is derived from it, so two sites see two
 * unrelated account ids and cannot link the same person by comparing ids.
 * The secret lives in a private field and is never printed or serialised by accident.
 */
export class AccountKey {
  #seed: Buffer;

  private constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error("A login key must be 32 bytes.");
    this.#seed = Buffer.from(seed);
  }

  /** Make a new random login key with Node's own random source. */
  static generate(): AccountKey {
    return new AccountKey(randomBytes(32));
  }

  /** Rebuild a login key from fixed bytes (test vectors only). */
  static fromSeed(seed: Uint8Array): AccountKey {
    return new AccountKey(Buffer.from(seed));
  }

  /** The Ed25519 key this login key uses for one site. */
  siteKey(siteId: string): SiteKey {
    const derived = createHmac("sha256", this.#seed).update(`imani login site key v1\n${siteId}`).digest();
    return new SiteKey(derived);
  }

  /** Internal: used by exportAccountKey only. */
  static _exportSeed(key: AccountKey): Buffer {
    return Buffer.from(key.#seed);
  }

  toJSON(): string {
    return "[AccountKey hidden]";
  }
  toString(): string {
    return "[AccountKey hidden]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[AccountKey hidden]";
  }
}

/** One site's signing key. Its public half, in base64url, is the account id that site stores. */
export class SiteKey {
  #seed: Buffer;
  readonly publicKey: string;

  constructor(seed: Buffer) {
    this.#seed = seed;
    const pub = createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" }) as Buffer;
    this.publicKey = b64urlEncode(pub.subarray(SPKI_PREFIX.length));
  }

  sign(message: string): string {
    return b64urlEncode(sign(null, Buffer.from(message, "utf8"), privateKeyFromSeed(this.#seed)));
  }

  toJSON(): string {
    return `[SiteKey ${this.publicKey}]`;
  }
  toString(): string {
    return `[SiteKey ${this.publicKey}]`;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `[SiteKey ${this.publicKey}]`;
  }
}

function privateKeyFromSeed(seed: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Check an Ed25519 signature made by an account id (base64url public key). Never throws. */
export function verifySignature(accountId: string, message: string, signature: string): boolean {
  try {
    const raw = b64urlDecode(accountId);
    const sig = b64urlDecode(signature);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), pub, sig);
  } catch {
    return false;
  }
}

/**
 * Turn a login key into one line of text the user can keep as a backup.
 * There is no cloud copy and no recovery service: this string is the only backup.
 * Show EXPORT_WARNING next to it.
 */
export function exportAccountKey(key: AccountKey): string {
  return EXPORT_PREFIX + b64urlEncode(AccountKey._exportSeed(key));
}

/** Read a backup made by exportAccountKey. Throws a plain error that never repeats the input. */
export function importAccountKey(text: string): AccountKey {
  const t = text.trim();
  if (!t.startsWith(EXPORT_PREFIX)) throw new Error("This is not an imani login key backup.");
  let seed: Buffer;
  try {
    seed = b64urlDecode(t.slice(EXPORT_PREFIX.length));
  } catch {
    throw new Error("The login key backup is damaged.");
  }
  if (seed.length !== 32) throw new Error("The login key backup is damaged.");
  return AccountKey.fromSeed(seed);
}
