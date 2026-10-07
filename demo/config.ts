// Settings for the shop auction demo. Two modes:
//   simulated (default): committed offline test data, a pretend block clock, no network at all.
//   live (--live): real payments read through src/fetch. Needs the environment variables below,
//   and refuses to start without them, so it can never quietly fall back to fake data.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEMO_DIR = join(ROOT, "demo");

export type Mode = "sim" | "live";
export type Network = "main" | "test";

export interface LotInfo {
  lotId: string;
  title: string;
  description: string;
  network: Network;
  /** The lot's own receiving address. Public: bidders pay it. */
  address: string;
  closeHeight: number;
  itemCount: number;
  reserveZat: number;
}

export interface SimLotInfo extends LotInfo {
  simulated: {
    startHeight: number;
    afterRefundsHeight: number;
    yourBid: { txid: string; amountZat: number; memo: string; height: number };
  };
}

export interface DemoConfig {
  mode: Mode;
  port: number;
  /** Site id written into every login memo. */
  siteId: string;
  /** The site's own login address and its read-only viewing key. Never a spending key. */
  loginAddress: string;
  loginUfvk: string;
  sessionSecret: string;
  /** Live mode: light servers to read payments from (empty = the fetch helper's defaults). */
  servers: string[];
  proxy?: string;
  /** Live mode: folder with lot.json, and after the close disclosure.json and result.json. */
  lotDir?: string;
  /** Simulated mode: folder with the recorded round (disclosure.json, result.json). */
  roundDir: string;
  /** Simulated mode: folder with the tampered copies and manifest.json. */
  brokenDir: string;
  /** Where log lines go. Lines carry event names only, never keys, memos or addresses. */
  log: (line: string) => void;
}

export class ConfigError extends Error {}

export const LIVE_ENV = [
  ["IMANI_LOGIN_ADDRESS", "the shop's own shielded or unified address, used only for sign-in payments"],
  ["IMANI_LOGIN_UFVK", "the read-only viewing key for that address (uview1... or uviewtest1...)"],
  ["IMANI_SESSION_SECRET", "a random secret of at least 32 characters for signing session cookies"],
  ["IMANI_SITE_ID", "the site's host name as users see it, for example shop.example (default: localhost:<port>)"],
  ["IMANI_SERVERS", "optional: comma-separated light servers, for example https://zec.rocks:443 (default: the fetch helper's list)"],
  ["IMANI_PROXY", "optional: a SOCKS5 proxy such as socks5h://127.0.0.1:9050 so servers do not see your internet address"],
  ["IMANI_LOT_DIR", "optional: folder with lot.json, and after the close the seller's disclosure.json and result.json"],
] as const;

/** Throwaway site address and viewing key from the committed login test data (test network only). */
export function simLoginParty(): { address: string; ufvk: string } {
  const data = JSON.parse(readFileSync(join(ROOT, "test", "login", "vectors", "login-offline.json"), "utf8"));
  const site = data.parties["site shop.example"];
  return { address: site.address, ufvk: site.ufvk };
}

export function simLot(): SimLotInfo {
  return JSON.parse(readFileSync(join(DEMO_DIR, "data", "lot-01.json"), "utf8"));
}

export interface LoadOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** Read the command line and environment. Live mode fails closed with a plain list of what is missing. */
export function loadConfig(opts: LoadOptions = {}): DemoConfig {
  const argv = opts.argv ?? [];
  const env = opts.env ?? {};
  const live = argv.includes("--live");
  let port = Number(env.IMANI_PORT ?? 8787);
  const pi = argv.indexOf("--port");
  if (pi !== -1) port = Number(argv[pi + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("The port must be a whole number from 0 to 65535.");
  const log = opts.log ?? ((line: string) => console.log(line));
  const base = {
    port,
    roundDir: join(ROOT, "examples", "round-01"),
    brokenDir: join(ROOT, "examples", "broken"),
    log,
  };

  if (!live) {
    const party = simLoginParty();
    return {
      ...base,
      mode: "sim",
      siteId: "imani-shop.example",
      loginAddress: party.address,
      loginUfvk: party.ufvk,
      // A fresh secret each run: simulated sessions end when the demo stops.
      sessionSecret: randomBytes(32).toString("base64url"),
      servers: [],
    };
  }

  const missing = LIVE_ENV.slice(0, 3).filter(([name]) => !env[name] || !String(env[name]).trim());
  if (missing.length) {
    throw new ConfigError(
      "Live mode needs real settings and will not start without them. Missing:\n" +
        missing.map(([name, what]) => `  ${name}: ${what}`).join("\n") +
        "\nNothing was contacted. Run without --live for the simulated demo.",
    );
  }
  const secret = String(env.IMANI_SESSION_SECRET);
  if (secret.length < 32) throw new ConfigError("IMANI_SESSION_SECRET must be at least 32 characters.");
  const ufvk = String(env.IMANI_LOGIN_UFVK).trim();
  if (!/^uview(test)?1/.test(ufvk)) {
    throw new ConfigError("IMANI_LOGIN_UFVK must be a read-only unified full viewing key (starts with uview1 or uviewtest1). Never give the shop a spending key or seed phrase.");
  }
  const servers = (env.IMANI_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    ...base,
    mode: "live",
    siteId: (env.IMANI_SITE_ID ?? "").trim() || `localhost:${port}`,
    loginAddress: String(env.IMANI_LOGIN_ADDRESS).trim(),
    loginUfvk: ufvk,
    sessionSecret: secret,
    servers,
    proxy: env.IMANI_PROXY?.trim() || undefined,
    lotDir: env.IMANI_LOT_DIR?.trim() || undefined,
  };
}
