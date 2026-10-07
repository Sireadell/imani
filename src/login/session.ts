import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";

export interface Session {
  accountId: string;
  /** Unix time in seconds when the session ends. */
  expiresAt: number;
}

/** Turns an account id into a session value and back. Two versions ship: signed cookie and session id. */
export interface SessionIssuer {
  issue(accountId: string, now?: number): string | Promise<string>;
  read(value: string, now?: number): Session | undefined | Promise<Session | undefined>;
  end?(value: string): void | Promise<void>;
}

/**
 * Signed cookie value: "s1.<payload>.<HMAC-SHA256>". The payload holds only the account id and
 * the expiry. Nothing else from the login (no memo, no address, no viewing key) goes in.
 */
export class SignedSessions implements SessionIssuer {
  #secret: Buffer;
  #ttl: number;
  constructor(secret: string | Uint8Array, ttlSeconds = 7 * 86_400) {
    const s = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
    if (s.length < 32) throw new Error("Session secret must be at least 32 bytes.");
    this.#secret = s;
    this.#ttl = ttlSeconds;
  }
  issue(accountId: string, now = Math.floor(Date.now() / 1000)): string {
    const payload = b64urlEncode(Buffer.from(JSON.stringify({ a: accountId, e: now + this.#ttl }), "utf8"));
    return `s1.${payload}.${this.#mac(payload)}`;
  }
  read(value: string, now = Math.floor(Date.now() / 1000)): Session | undefined {
    const parts = typeof value === "string" ? value.split(".") : [];
    if (parts.length !== 3 || parts[0] !== "s1") return undefined;
    const want = Buffer.from(this.#mac(parts[1]));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try {
      const p = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
      if (typeof p.a !== "string" || typeof p.e !== "number" || now > p.e) return undefined;
      return { accountId: p.a, expiresAt: p.e };
    } catch {
      return undefined;
    }
  }
  #mac(payload: string): string {
    return b64urlEncode(createHmac("sha256", this.#secret).update(`imani session v1\n${payload}`).digest());
  }
  toJSON(): string {
    return "[SignedSessions]";
  }
}

/** Plain random session ids kept in memory. Swap in your own SessionIssuer for a database. */
export class MemorySessions implements SessionIssuer {
  #sessions = new Map<string, Session>();
  #ttl: number;
  constructor(ttlSeconds = 7 * 86_400) {
    this.#ttl = ttlSeconds;
  }
  issue(accountId: string, now = Math.floor(Date.now() / 1000)): string {
    const id = b64urlEncode(randomBytes(24));
    this.#sessions.set(id, { accountId, expiresAt: now + this.#ttl });
    return id;
  }
  read(value: string, now = Math.floor(Date.now() / 1000)): Session | undefined {
    const s = this.#sessions.get(value);
    if (!s || now > s.expiresAt) return undefined;
    return { ...s };
  }
  end(value: string): void {
    this.#sessions.delete(value);
  }
}
