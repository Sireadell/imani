// The shop auction demo as one request handler (Node http only, no framework).
// Simulated mode: offline, pretend wallet and clock. Live mode: real payments via src/fetch.
// Both modes sign people in with the same LoginKit.verify call on raw transaction bytes.
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LoginKit, SignedSessions } from "../src/login/index.ts";
import { toHtml } from "../src/report.ts";
import { ChainError, LiveChain, SimChain, type Chain } from "./chain.ts";
import { DEMO_DIR, simLot, type DemoConfig, type LotInfo } from "./config.ts";
import { Lot } from "./lot.ts";
import * as P from "./pages.ts";

export const SESSION_COOKIE = "imani_session";
const STATIC_DIR = join(DEMO_DIR, "public");
const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface DemoApp {
  handle(req: IncomingMessage, res: ServerResponse): void;
  cfg: DemoConfig;
  lot: Lot | null;
  chain: Chain;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function loadLiveLot(cfg: DemoConfig): LotInfo | null {
  if (!cfg.lotDir) return null;
  const file = join(cfg.lotDir, "lot.json");
  if (!existsSync(file)) return null;
  const l = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["lotId", "title", "address", "closeHeight", "itemCount", "reserveZat"]) {
    if (l[k] === undefined) throw new Error(`lot.json in IMANI_LOT_DIR is missing "${k}".`);
  }
  return { description: "", network: "main", ...l };
}

export function createApp(cfg: DemoConfig): DemoApp {
  const sim = cfg.mode === "sim";
  const simChain = sim ? new SimChain(cfg.loginAddress, simLot()) : null;
  const kit = new LoginKit({
    siteId: cfg.siteId,
    siteAddress: cfg.loginAddress,
    viewingKey: cfg.loginUfvk,
    readTx: simChain ? simChain.reader() : undefined,
    // Event names only, for example "login_failed:code_expired". Never a memo or a key.
    log: (event) => cfg.log(`login: ${event}`),
  });
  const chain: Chain = simChain ?? new LiveChain({ network: kit.network, servers: cfg.servers, proxy: cfg.proxy });
  const sessions = new SignedSessions(cfg.sessionSecret, 12 * 3600);
  const lotInfo = sim ? simLot() : loadLiveLot(cfg);
  const lot = lotInfo ? new Lot(cfg, lotInfo) : null;
  const contacted = new Set<string>();
  const MIN_ZAT = 10_000;

  const ctxFor = (account: string | null): P.PageContext => ({
    mode: cfg.mode,
    network: kit.network,
    account,
    lot,
    serversContacted: [...contacted],
    loginMinZat: MIN_ZAT,
  });

  function accountOf(req: IncomingMessage): string | null {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === SESSION_COOKIE) return sessions.read(v.join("="))?.accountId ?? null;
    }
    return null;
  }

  function sessionValue(req: IncomingMessage): string | null {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === SESSION_COOKIE) return v.join("=") || null;
    }
    return null;
  }

  function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string | string[]> = {}) {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      "Cache-Control": "no-store",
      ...extra,
    });
    res.end(body);
  }
  const html = (res: ServerResponse, body: string, status = 200) => send(res, status, "text/html; charset=utf-8", body);
  const json = (res: ServerResponse, obj: unknown, status = 200, extra: Record<string, string | string[]> = {}) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(obj), extra);
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}) =>
    send(res, 303, "text/plain; charset=utf-8", "", { Location: to, ...extra });

  async function body(req: IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16_384) throw new HttpError(413, "Request too large.");
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const type = String(req.headers["content-type"] ?? "");
    if (type.startsWith("application/json")) {
      try {
        const o = JSON.parse(text || "{}");
        return o && typeof o === "object" ? o : {};
      } catch {
        throw new HttpError(400, "The request was not valid JSON.");
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  }

  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

  function serveStatic(res: ServerResponse, pathname: string) {
    const rel = normalize(pathname.slice("/static/".length)).replace(/^([.][.][\\/])+/, "");
    const type = STATIC_TYPES[extname(rel)];
    const file = join(STATIC_DIR, rel);
    if (!type || !file.startsWith(STATIC_DIR) || !existsSync(file)) throw new HttpError(404, "Not found.");
    send(res, 200, type, readFileSync(file));
  }

  function needLot(): Lot {
    if (!lot) throw new HttpError(404, "No lot is set up.");
    return lot;
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const account = accountOf(req);
    const ctx = ctxFor(account);

    // A form or script from another website must not act on this shop.
    if (method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin !== "null" && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Requests from other websites are refused.");
    }

    if (method === "GET" && path.startsWith("/static/")) return serveStatic(res, path);
    if (method === "GET" && path === "/") return html(res, P.homePage(ctx));
    if (method === "GET" && path === "/privacy") return html(res, P.privacyPage(ctx));
    if (method === "GET" && path === "/signin") return html(res, P.signinPage(ctx, { siteId: cfg.siteId, network: kit.network, minZat: MIN_ZAT }));
    if (method === "GET" && path === "/lot") return html(res, P.lotPage(ctx));
    if (method === "GET" && path === "/seller") return html(res, P.sellerPage(ctx));
    if (method === "GET" && path === "/check") return html(res, P.checkPage(ctx, lot ? lot.brokenCopies() : []));

    if (method === "GET" && path === "/login/challenge") {
      const c = await kit.newChallenge();
      return json(res, c);
    }
    if (method === "POST" && path === "/login/challenge") {
      // The page reserves the code for its own account id, so only its key can use the code.
      const b = await body(req);
      try {
        return json(res, await kit.newChallenge(String(b.accountId ?? "")));
      } catch {
        throw new HttpError(400, "The sign-in request could not be handled.");
      }
    }
    if (method === "POST" && path === "/login/verify") {
      const b = await body(req);
      let lookup;
      try {
        lookup = await chain.getTx(String(b.txid ?? ""));
      } catch (e) {
        if (e instanceof ChainError) {
          for (const s of e.serversContacted) contacted.add(s);
          cfg.log("login: payment_not_read");
          return json(res, { ok: false, reason: "payment_not_read", message: `${e.message} You are not signed in.`, serversContacted: e.serversContacted }, 200);
        }
        throw e;
      }
      for (const s of lookup.serversContacted) contacted.add(s);
      const r = await kit.verify(lookup.hex, typeof b.proof === "string" ? b.proof : undefined);
      if (!r.ok) return json(res, { ok: false, reason: r.reason, message: `${r.message} You are not signed in.`, serversContacted: lookup.serversContacted });
      return json(
        res,
        { ok: true, accountId: r.accountId, learned: r.siteLearned, serversContacted: lookup.serversContacted },
        200,
        { "Set-Cookie": cookie(sessions.issue(r.accountId), 12 * 3600) },
      );
    }
    if (method === "GET" && path === "/receipt.json") {
      // What this shop stores for the signed-in account, read from the shop's real storage. The cookie itself
      // is searched but never shown (it is HttpOnly), so the receipt shows only what is inside it.
      const raw = sessionValue(req);
      const s = raw ? sessions.read(raw) : undefined;
      if (!raw || !s) return json(res, { ok: false, message: "Sign in first." }, 401);
      const receipt = kit.receipt(s.accountId, {
        held: [{ where: "session cookie", text: raw, show: `account id ${s.accountId}, ends ${new Date(s.expiresAt * 1000).toISOString()}` }],
        probes: [{ label: "the shop's session secret", value: cfg.sessionSecret }],
      });
      return json(res, { ok: true, receipt });
    }
    if (method === "POST" && path === "/logout") {
      const wantsJson = String(req.headers.accept ?? "").includes("application/json");
      const clear = { "Set-Cookie": cookie("", 0) };
      return wantsJson ? json(res, { ok: true }, 200, clear) : redirect(res, "/", clear);
    }

    if (method === "POST" && path === "/seller/publish") {
      const l = needLot();
      try {
        l.publish();
      } catch (e) {
        return html(res, P.sellerPage(ctx, (e as Error).message), 400);
      }
      cfg.log("seller: published");
      return redirect(res, "/seller");
    }
    if (method === "POST" && path === "/check") {
      const b = await body(req);
      const run = needLot().runCheck(String(b.copy ?? "published"));
      cfg.log(`check: ${run.verdict ? run.verdict.result : "error"}`);
      return html(res, P.resultPage(ctx, run), run.error ? 400 : 200);
    }
    if (method === "GET" && (path === "/check/report.html" || path === "/check/verdict.json")) {
      const run = needLot().runCheck(url.searchParams.get("copy") ?? "published");
      if (!run.verdict) throw new HttpError(404, run.error ?? "Not found.");
      const name = `lot-${run.verdict.lotId}-${run.copy === "published" ? "check" : run.copy}`;
      if (path.endsWith(".html")) return send(res, 200, "text/html; charset=utf-8", toHtml(run.verdict), { "Content-Disposition": `attachment; filename="${name}.html"` });
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(run.verdict, null, 2) + "\n", { "Content-Disposition": `attachment; filename="${name}.json"` });
    }
    if (method === "GET" && (path === "/lot/files/result.json" || path === "/lot/files/disclosure.json")) {
      const pub = needLot().published;
      if (!pub) throw new HttpError(404, "The seller has not published this file yet.");
      // The disclosure file is the one place the lot key leaves the shop: that is what publishing means.
      const file = path.endsWith("result.json") ? pub.result : pub.disclosure;
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(file, null, 2) + "\n", {
        "Content-Disposition": `attachment; filename="${path.endsWith("result.json") ? "result" : "disclosure"}.json"`,
      });
    }

    // ---- Simulated mode only: pretend wallet, pretend clock, restart ----
    if (path.startsWith("/sim/")) {
      if (!simChain || !lot) throw new HttpError(404, "Not found.");
      if (method === "POST" && path === "/sim/chain/send") {
        const b = await body(req);
        try {
          const r = simChain.send(String(b.uri ?? ""), lot.height ?? 0);
          if (r.kind === "bid") lot.recordYourBid();
          return json(res, { ok: true, txid: r.txid });
        } catch (e) {
          if (e instanceof ChainError) return json(res, { ok: false, message: e.message }, 400);
          throw e;
        }
      }
      if (method === "POST" && path === "/sim/clock") {
        const b = await body(req);
        lot.skipToAfterClose();
        const back = ["/lot", "/seller"].includes(String(b.back)) ? String(b.back) : "/seller";
        return redirect(res, back);
      }
      if (method === "POST" && path === "/sim/reset") {
        lot.reset();
        simChain.reset();
        return redirect(res, "/", { "Set-Cookie": cookie("", 0) });
      }
    }
    throw new HttpError(404, "Not found.");
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "/").split("?")[0];
    route(req, res)
      .then(() => cfg.log(`${req.method} ${path} ${res.statusCode}`))
      .catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        // Unknown errors get a fixed message, so nothing from a request can leak into a reply or log.
        const message = e instanceof HttpError ? e.message : "Something went wrong. Nothing was saved.";
        cfg.log(`${req.method} ${path} ${status}`);
        if (res.headersSent) return res.end();
        const wantsJson = String(req.headers.accept ?? "").includes("application/json") || String(req.headers["content-type"] ?? "").includes("json");
        if (wantsJson) return json(res, { ok: false, message }, status);
        if (status === 404) return html(res, P.notFoundPage(ctxFor(accountOf(req))), 404);
        return html(res, P.layout(ctxFor(accountOf(req)), "Error", "", `<h1>Something went wrong</h1><p class="notice bad">${P.esc(message)}</p><p><a href="/">Back to the shop</a></p>`), status);
      });
  }

  return { handle, cfg, lot, chain };
}
