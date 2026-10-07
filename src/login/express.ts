// Express add-on. It uses only the plain Node request and response methods that Express
// also provides, so Express is not a dependency: install it in your own app.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginKit } from "./kit.ts";
import type { SessionIssuer } from "./session.ts";

export interface ExpressLoginOptions {
  kit: LoginKit;
  sessions: SessionIssuer;
  /** Where the three routes live. Default "/zcash-login". */
  basePath?: string;
  cookieName?: string;
  /** Set false only for local http testing. Default true. */
  secureCookie?: boolean;
  /** Largest request body in bytes. Default 1,000,000 (a transaction in hex). */
  bodyLimit?: number;
}

type Req = IncomingMessage & { body?: unknown; path?: string; zcashAccount?: string };
type Next = (err?: unknown) => void;

/**
 * Routes:
 *   GET  {base}/challenge  returns a fresh one-time code (public data only)
 *   POST {base}/verify     body {"txHex": "..."}; on success sets the session cookie
 *   POST {base}/logout     clears the cookie
 * Every other request passes through with req.zcashAccount set when the session cookie is valid.
 */
export function zcashLogin(opts: ExpressLoginOptions) {
  const base = (opts.basePath ?? "/zcash-login").replace(/\/$/, "");
  const cookieName = opts.cookieName ?? "imani_session";
  const secure = opts.secureCookie ?? true;
  const limit = opts.bodyLimit ?? 1_000_000;

  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  return async function zcashLoginMiddleware(req: Req, res: ServerResponse, next: Next): Promise<void> {
    try {
      const path = req.path ?? new URL(req.url ?? "/", "http://local").pathname;
      if (req.method === "GET" && path === `${base}/challenge`) {
        return send(res, 200, await opts.kit.newChallenge());
      }
      if (req.method === "POST" && path === `${base}/verify`) {
        const body = await readBody(req, limit);
        const txHex = body && typeof body === "object" ? (body as Record<string, unknown>).txHex : undefined;
        const result = await opts.kit.verify(typeof txHex === "string" ? txHex : "");
        if (!result.ok) return send(res, 401, { reason: result.reason, message: result.message });
        const value = await opts.sessions.issue(result.accountId);
        res.setHeader("Set-Cookie", cookie(value, 7 * 86_400));
        return send(res, 200, { accountId: result.accountId, siteLearned: result.siteLearned });
      }
      if (req.method === "POST" && path === `${base}/logout`) {
        const v = readCookie(req, cookieName);
        if (v && opts.sessions.end) await opts.sessions.end(v);
        res.setHeader("Set-Cookie", cookie("", 0));
        return send(res, 200, { ok: true });
      }
      const v = readCookie(req, cookieName);
      if (v) {
        const s = await opts.sessions.read(v);
        if (s) req.zcashAccount = s.accountId;
      }
      next();
    } catch {
      // Never pass internal error text on: it could quote request data.
      send(res, 400, { reason: "bad_request", message: "The login request could not be handled." });
    }
  };
}

/** Use after zcashLogin on routes that need a signed-in user. */
export function requireZcashLogin(req: Req, res: ServerResponse, next: Next): void {
  if (req.zcashAccount) return next();
  send(res, 401, { reason: "not_signed_in", message: "Sign in first." });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

async function readBody(req: Req, limit: number): Promise<unknown> {
  if (req.body !== undefined && typeof req.body === "object") return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
