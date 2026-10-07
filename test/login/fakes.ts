// Shared test fixtures for the adapter and leak tests.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { LoginKit, zcashLogin } from "../../src/login/index.ts";
import { T0, fixedKey } from "./helpers.ts";
import { SITE_ADDRESS, SITE_ID, proofsByLabel, siteCodes } from "./offline-plan.ts";

export const v = JSON.parse(readFileSync(new URL("./vectors/login-offline.json", import.meta.url), "utf8"));
export const P = await proofsByLabel();
export const UFVK = v.parties["site shop.example"].ufvk;
export const SECRET = "test session secret, at least thirty-two bytes long";
export const ACCOUNT = fixedKey("user").siteKey(SITE_ID).publicKey;

export async function makeKit(log?: (e: string) => void) {
  const { store } = await siteCodes();
  return new LoginKit({ siteId: SITE_ID, siteAddress: SITE_ADDRESS, viewingKey: UFVK, store, clock: () => T0 + 60, log });
}

/** Minimal stand-ins for Express's req and res: the middleware only uses plain Node methods. */
export function fakeReq(method: string, url: string, opts: { body?: unknown; raw?: string; cookie?: string } = {}) {
  const req = Readable.from(opts.raw !== undefined ? [Buffer.from(opts.raw)] : []) as any;
  req.method = method;
  req.url = url;
  req.headers = opts.cookie ? { cookie: opts.cookie } : {};
  if (opts.body !== undefined) req.body = opts.body;
  return req;
}
export function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: "" };
  res.setHeader = (k: string, val: string) => (res.headers[k.toLowerCase()] = val);
  res.end = (b?: string) => (res.body = b ?? "");
  return res;
}

export async function run(mw: ReturnType<typeof zcashLogin>, req: any) {
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => (nextCalled = true));
  return { res, nextCalled, json: res.body ? JSON.parse(res.body) : undefined };
}

