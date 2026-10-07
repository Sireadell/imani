import { randomBytes } from "node:crypto";

export type Network = "main" | "test";

/** A one-time login code the site shows. It works once, before it expires, for one site, address and network. */
export interface Challenge {
  /** Readable one-time code, for example 7K4Q-M2XD-RW8T-HC3N-P5VA. */
  nonce: string;
  /** Site id the code was made for, usually the site's domain, for example shop.example. */
  siteId: string;
  /** The site's own receiving address. The payment link pays this address and nothing else. */
  siteAddress: string;
  network: Network;
  /** Unix time in seconds after which the code is refused. */
  expiresAt: number;
  /** Smallest payment, in zatoshis, that counts as a login. */
  minZat: number;
  /**
   * Optional: the account id (the user's site key) this code is reserved for. When set, only a memo made by
   * that key can use the code, so someone who merely sees the code cannot burn it.
   */
  accountId?: string;
}

/**
 * Where a site keeps its one-time codes and the transactions it has already used.
 * Every method may return a promise, so a database or a shared cache can stand behind it.
 * consume and markTransactionUsed must be atomic: they return true for exactly one caller.
 */
export interface StoredChallenge extends Challenge {
  used: boolean;
}

export interface ChallengeStore {
  put(challenge: Challenge): void | Promise<void>;
  /** The code with its used flag, or undefined if the site never made it (or has since forgotten it). */
  get(nonce: string): StoredChallenge | undefined | Promise<StoredChallenge | undefined>;
  /** Mark the code used. True only the first time, false if missing or already used. */
  consume(nonce: string): boolean | Promise<boolean>;
  /** Remember a transaction id. True only the first time it is seen. */
  markTransactionUsed(txid: string): boolean | Promise<boolean>;
}

/** Default store: plain memory inside one process. Each instance is separate; there is no global state. */
export class MemoryChallengeStore implements ChallengeStore {
  #challenges = new Map<string, StoredChallenge>();
  #txids = new Set<string>();

  put(challenge: Challenge): void {
    if (this.#challenges.has(challenge.nonce)) throw new Error("A login code with this value already exists.");
    this.#challenges.set(challenge.nonce, { ...challenge, used: false });
  }
  get(nonce: string): StoredChallenge | undefined {
    const c = this.#challenges.get(nonce);
    return c ? { ...c } : undefined;
  }
  consume(nonce: string): boolean {
    const c = this.#challenges.get(nonce);
    if (!c || c.used) return false;
    c.used = true;
    return true;
  }
  markTransactionUsed(txid: string): boolean {
    if (this.#txids.has(txid)) return false;
    this.#txids.add(txid);
    return true;
  }
  /**
   * Forget codes that expired before `now` (seconds). Safe: an expired code is refused anyway,
   * and a forgotten one is refused as unknown. Transaction ids are kept.
   */
  sweep(now: number = Math.floor(Date.now() / 1000)): number {
    let n = 0;
    for (const [k, c] of this.#challenges) {
      if (c.expiresAt < now) {
        this.#challenges.delete(k);
        n++;
      }
    }
    return n;
  }
}

// Readable code alphabet: no 0, O, 1, I or L, so a code read aloud or typed by hand survives.
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_GROUPS = 5;
const CODE_GROUP_LEN = 4;
export const NONCE_PATTERN = /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){4}$/;

/** 20 random symbols from a 31-symbol alphabet, about 99 bits, grouped as XXXX-XXXX-XXXX-XXXX-XXXX. */
export function makeNonce(random: (n: number) => Uint8Array = randomBytes): string {
  const out: string[] = [];
  while (out.length < CODE_GROUPS * CODE_GROUP_LEN) {
    for (const b of random(32)) {
      // Rejection sampling keeps every symbol equally likely (248 = 8 * 31).
      if (b < 248 && out.length < CODE_GROUPS * CODE_GROUP_LEN) out.push(CODE_ALPHABET[b % 31]);
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) groups.push(out.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN).join(""));
  return groups.join("-");
}

// A site id is a lower-case host name, optionally with a port: shop.example or localhost:3000.
export const SITE_ID_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?(:[0-9]{1,5})?$/;
const ADDRESS_PATTERN = /^[a-z0-9]{20,500}$/;

export interface ChallengeOptions {
  siteId: string;
  siteAddress: string;
  network: Network;
  /** How long the code stays valid, in seconds. Default 600 (10 minutes). */
  ttlSeconds?: number;
  /** Smallest payment in zatoshis. Default 10,000 (0.0001 ZEC). */
  minZat?: number;
  /** Clock override in seconds, for tests. */
  now?: number;
  /** Random source override, for tests and conformance vectors. */
  random?: (n: number) => Uint8Array;
  /** Reserve the code for this account id (43 characters, base64url). See Challenge.accountId. */
  accountId?: string;
}

/** Make a one-time code and save it in the store. */
export async function createChallenge(store: ChallengeStore, opts: ChallengeOptions): Promise<Challenge> {
  if (!SITE_ID_PATTERN.test(opts.siteId)) throw new Error("Site id must be a lower-case host name such as shop.example.");
  if (!ADDRESS_PATTERN.test(opts.siteAddress)) throw new Error("Site address is not a Zcash shielded or unified address.");
  if (opts.network !== "main" && opts.network !== "test") throw new Error('Network must be "main" or "test".');
  if (!addressMatchesNetwork(opts.siteAddress, opts.network)) throw new Error("Site address belongs to the other network.");
  const ttl = opts.ttlSeconds ?? 600;
  const minZat = opts.minZat ?? 10_000;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 86_400) throw new Error("Code lifetime must be 1 to 86,400 seconds.");
  if (!Number.isInteger(minZat) || minZat < 1) throw new Error("Minimum payment must be at least 1 zatoshi.");
  if (opts.accountId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(opts.accountId)) throw new Error("Account id must be 43 base64url characters.");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const challenge: Challenge = {
    nonce: makeNonce(opts.random),
    siteId: opts.siteId,
    siteAddress: opts.siteAddress,
    network: opts.network,
    expiresAt: now + ttl,
    minZat,
    ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
  };
  await store.put(challenge);
  return challenge;
}

/** Unified (u1 / utest1) and Sapling (zs / ztestsapling) addresses carry their network in the prefix. */
export function addressMatchesNetwork(address: string, network: Network): boolean {
  if (network === "test") return address.startsWith("utest1") || address.startsWith("ztestsapling1");
  return (address.startsWith("u1") || address.startsWith("zs1"));
}

/** Network of a unified full viewing key, from its prefix. */
export function networkOfViewingKey(ufvk: string): Network | undefined {
  if (ufvk.startsWith("uviewtest1")) return "test";
  if (ufvk.startsWith("uview1")) return "main";
  return undefined;
}
