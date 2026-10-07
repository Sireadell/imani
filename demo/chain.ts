// Where the shop gets payment bytes from.
//   SimChain: a pretend network inside this process. A pretend wallet "sends" payments to it.
//   LiveChain: real Zcash transactions fetched by id through src/fetch, checked by two servers.
// Both hand raw transaction bytes to the same login check (LoginKit.verify). Only the reader of
// those bytes differs: the simulated one reads its own records, the live one is the real decoder.
import { createHash, randomBytes } from "node:crypto";
import { checkSinglePayee } from "../src/login/index.ts";
import type { TxReader } from "../src/login/index.ts";
import type { SimLotInfo } from "./config.ts";

export interface TxLookup {
  hex: string;
  /** Servers this lookup opened a connection to. Empty for the simulated chain. */
  serversContacted: string[];
}

export class ChainError extends Error {
  readonly serversContacted: string[];
  constructor(message: string, serversContacted: string[] = []) {
    super(message);
    this.serversContacted = serversContacted;
  }
}

export interface Chain {
  readonly kind: "sim" | "live";
  /** Raw transaction bytes (hex) for a transaction id. Throws ChainError with a plain message. */
  getTx(txid: string): Promise<TxLookup>;
}

interface SimOutput {
  to: string;
  amountZat: number;
  memo: string;
}

const TXID_RE = /^[0-9a-f]{64}$/;
const SIM_PREFIX = Buffer.from("imani-simulated-tx:", "utf8").toString("hex");

/** Read a ZIP 321 link the way a wallet would: one payee, decimal ZEC amount, base64url memo. */
export function parsePaymentLink(uri: string): { to: string; amountZat: number; memo: string } {
  if (typeof uri !== "string" || uri.length > 2000) throw new ChainError("The wallet could not read this payment link.");
  const single = checkSinglePayee(uri);
  if (!single.ok) throw new ChainError(`The wallet refused this payment link: ${single.reason}.`);
  const q = uri.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : uri.slice(q + 1).replace(/\+/g, "%2B"));
  const amount = params.get("amount") ?? "";
  const m = /^([0-9]{1,8})(?:\.([0-9]{1,8}))?$/.exec(amount);
  if (!m) throw new ChainError("The wallet refused this payment link: the amount is missing or not a ZEC amount.");
  const amountZat = Number(m[1]) * 1e8 + Number((m[2] ?? "").padEnd(8, "0"));
  const memoB64 = params.get("memo") ?? "";
  if (!/^[A-Za-z0-9_-]*$/.test(memoB64)) throw new ChainError("The wallet refused this payment link: the memo is not base64url.");
  const memoBytes = Buffer.from(memoB64, "base64url");
  if (memoBytes.length > 512) throw new ChainError("The wallet refused this payment link: the memo is longer than 512 bytes.");
  return { to: single.address, amountZat, memo: memoBytes.toString("utf8") };
}

/**
 * A pretend Zcash network for the simulated mode. Payments to the shop's login address are kept
 * here. Bids to the lot address replay the recorded test round, because only that round's real
 * transactions can be read with the lot key.
 */
export class SimChain implements Chain {
  readonly kind = "sim" as const;
  #txs = new Map<string, SimOutput[]>();
  #loginAddress: string;
  #lot: SimLotInfo;

  constructor(loginAddress: string, lot: SimLotInfo) {
    this.#loginAddress = loginAddress;
    this.#lot = lot;
  }

  /** The pretend wallet sends a payment. Returns the transaction id, as a real wallet would show it. */
  send(uri: string, height: number): { txid: string; kind: "login" | "bid" } {
    const p = parsePaymentLink(uri);
    if (p.to === this.#lot.address) {
      const want = this.#lot.simulated.yourBid;
      if (height > this.#lot.closeHeight) {
        throw new ChainError("The lot has closed. A bid sent now would arrive late, would not count and would be returned in full.");
      }
      if (p.amountZat !== want.amountZat || p.memo !== want.memo) {
        throw new ChainError("In simulated mode the bid replays bid 2 of the recorded test round, so it must be 0.02 ZEC with the memo shown.");
      }
      return { txid: want.txid, kind: "bid" };
    }
    if (p.to !== this.#loginAddress) throw new ChainError("The pretend network only knows this shop's addresses.");
    const txid = createHash("sha256").update(randomBytes(32)).digest("hex");
    this.#txs.set(txid, [{ to: p.to, amountZat: p.amountZat, memo: p.memo }]);
    return { txid, kind: "login" };
  }

  async getTx(txid: string): Promise<TxLookup> {
    const id = String(txid ?? "").trim().toLowerCase();
    if (!TXID_RE.test(id)) throw new ChainError("That is not a transaction id (64 letters and digits, 0 to 9 and a to f).");
    if (!this.#txs.has(id)) throw new ChainError("No payment with that transaction id was found on the pretend network.");
    return { hex: SIM_PREFIX + Buffer.from(id, "utf8").toString("hex"), serversContacted: [] };
  }

  /**
   * Reader for the login kit in simulated mode. Like a real viewing key, it shows only the
   * payments made to the address the key belongs to.
   */
  reader(): TxReader {
    return (txHex, viewingKey) => {
      if (typeof txHex !== "string" || !txHex.startsWith(SIM_PREFIX)) throw new Error("not a simulated transaction");
      const txid = Buffer.from(txHex.slice(SIM_PREFIX.length), "hex").toString("utf8");
      const outs = this.#txs.get(txid);
      if (!outs || !viewingKey) throw new Error("unknown simulated transaction");
      return {
        txid,
        outputs: outs
          .filter((o) => o.to === this.#loginAddress)
          .map((o) => ({ pool: "orchard" as const, amountZat: o.amountZat, memo: o.memo, transferType: "incoming" as const, recipientHex: "" })),
      };
    };
  }

  reset(): void {
    this.#txs.clear();
  }
}

export interface LiveChainOptions {
  network: "main" | "test";
  servers: string[];
  proxy?: string;
  timeoutMs?: number;
}

/** Real transactions, fetched by id and cross-checked by two servers run by different operators. */
export class LiveChain implements Chain {
  readonly kind = "live" as const;
  #opts: LiveChainOptions;
  constructor(opts: LiveChainOptions) {
    this.#opts = opts;
  }

  async getTx(txid: string): Promise<TxLookup> {
    const id = String(txid ?? "").trim().toLowerCase();
    if (!TXID_RE.test(id)) throw new ChainError("That is not a transaction id (64 letters and digits, 0 to 9 and a to f).");
    // Loaded only in live mode, so the simulated demo never loads network code.
    const { fetchTransactions, FetchError } = await import("../src/fetch/index.ts");
    try {
      const r = await fetchTransactions({
        network: this.#opts.network,
        txids: [id],
        servers: this.#opts.servers.length ? this.#opts.servers : undefined,
        proxy: this.#opts.proxy,
        timeoutMs: this.#opts.timeoutMs,
        retries: 0,
      });
      const tx = r.transactions.find((t) => t.txid === id);
      if (!tx) throw new ChainError("No payment with that transaction id was found.", r.serversContacted);
      return { hex: tx.hex, serversContacted: r.serversContacted };
    } catch (e) {
      if (e instanceof ChainError) throw e;
      const contacted = e instanceof FetchError ? e.serversContacted : [];
      throw new ChainError(
        "The payment could not be read from two independent Zcash servers (none answered, or they did not have it yet). If you just paid, wait a minute and try again.",
        contacted,
      );
    }
  }
}
