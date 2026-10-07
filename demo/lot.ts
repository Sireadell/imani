// The demo lot: its public facts, the pretend clock, the seller's publish step, and the check.
// The lot key (inside the disclosure file) stays in this process. It is never put in a page,
// a web address, a cookie or a log line. The only way out is the published disclosure file
// itself, after the close, which is the point of publishing it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLot, assertViewingKey, keyFingerprint, validateFiles, InputError, KeyRefusedError, type Verdict } from "../src/check.ts";
import { readTransactionWithId } from "../src/read.ts";
import type { Disclosure, SellerResult } from "../src/files.ts";
import type { DemoConfig, LotInfo, SimLotInfo } from "./config.ts";

export interface BrokenCopy {
  name: string;
  changed: string;
  expectedFailingCheck: string;
  story: string;
}

export interface Published {
  disclosure: Disclosure;
  result: SellerResult;
  /** 12-character fingerprint of the lot key. Safe to show. */
  fingerprint: string;
}

export interface SellerBidLine {
  height: number;
  amountZat: number;
  /** The bidder's memo word, for example m3x8. */
  word: string;
  late: boolean;
  yours: boolean;
}

export interface CheckRun {
  copy: string;
  verdict?: Verdict;
  error?: string;
  broken?: BrokenCopy;
  /** Plain list of numbers that differ from the honest result file. */
  changes: string[];
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

export class Lot {
  readonly info: LotInfo;
  readonly sim?: SimLotInfo["simulated"];
  height: number | null;
  published: Published | null = null;
  bidSent = false;
  #cfg: DemoConfig;
  /** Seller-side copy of the lot files (simulated mode). Holds the lot key; never rendered. */
  #sellerFiles: { disclosure: Disclosure; result: SellerResult } | null = null;
  #decoded: SellerBidLine[] | null = null;

  constructor(cfg: DemoConfig, info: LotInfo | SimLotInfo) {
    this.#cfg = cfg;
    this.info = info;
    if (cfg.mode === "sim" && "simulated" in info) {
      this.sim = info.simulated;
      this.height = info.simulated.startHeight;
      this.#sellerFiles = { disclosure: readJson(join(cfg.roundDir, "disclosure.json")), result: readJson(join(cfg.roundDir, "result.json")) };
    } else {
      this.height = null;
    }
  }

  get closed(): boolean {
    if (this.height !== null) return this.height > this.info.closeHeight;
    return this.published !== null;
  }

  /** Simulated: refunds are paid a few blocks after the close; the seller publishes after that. */
  get canPublish(): boolean {
    if (this.published) return false;
    if (this.sim && this.height !== null) return this.height >= this.sim.afterRefundsHeight;
    return !!this.#cfg.lotDir && existsSync(join(this.#cfg.lotDir, "disclosure.json")) && existsSync(join(this.#cfg.lotDir, "result.json"));
  }

  skipToAfterClose(): void {
    if (this.sim) this.height = Math.max(this.height ?? 0, this.sim.afterRefundsHeight);
  }

  recordYourBid(): void {
    if (this.sim) {
      this.bidSent = true;
      this.height = Math.max(this.height ?? 0, this.sim.yourBid.height);
    }
  }

  reset(): void {
    if (this.sim) this.height = this.sim.startHeight;
    this.published = null;
    this.bidSent = false;
  }

  /** The seller publishes the result file and the one-time lot key disclosure. */
  publish(): Published {
    if (!this.canPublish) throw new InputError(this.sim ? "Refunds are not paid yet. Skip the clock past the close first." : "The seller's files are not in IMANI_LOT_DIR yet.");
    const files = this.#sellerFiles ?? {
      disclosure: readJson(join(this.#cfg.lotDir!, "disclosure.json")),
      result: readJson(join(this.#cfg.lotDir!, "result.json")),
    };
    validateFiles(files.disclosure, files.result);
    if (files.disclosure.lotId !== this.info.lotId) throw new InputError(`The disclosure file is for lot ${files.disclosure.lotId}, not ${this.info.lotId}.`);
    const key = assertViewingKey(files.disclosure.ufvk, files.disclosure.network);
    this.published = { disclosure: files.disclosure, result: files.result, fingerprint: keyFingerprint(key) };
    return this.published;
  }

  /**
   * What the seller can see right now with the lot key (simulated mode only): every bid that has
   * arrived by the pretend block height. This is a known limit: the seller sees bids live.
   */
  sellerBids(): SellerBidLine[] {
    if (!this.sim || !this.#sellerFiles || this.height === null) return [];
    if (!this.#decoded) {
      const d = this.#sellerFiles.disclosure;
      const prefix = `bid:${d.lotId}:`;
      const lines: SellerBidLine[] = [];
      for (const t of d.transactions) {
        const r = readTransactionWithId(t.txHex, d.ufvk!);
        for (const o of r.outputs) {
          if (o.transferType === "incoming" && o.memo.startsWith(prefix)) {
            lines.push({ height: t.height, amountZat: o.amountZat, word: o.memo.slice(prefix.length), late: t.height > d.closeHeight, yours: r.txid === this.sim.yourBid.txid });
          }
        }
      }
      this.#decoded = lines.sort((a, b) => a.height - b.height);
    }
    const now = this.height;
    return this.#decoded.filter((b) => b.height <= now).map((b) => ({ ...b, yours: b.yours && this.bidSent }));
  }

  brokenCopies(): BrokenCopy[] {
    const m = readJson(join(this.#cfg.brokenDir, "manifest.json"));
    return m.copies as BrokenCopy[];
  }

  /** Run the checker on the published files, or on one tampered copy of the recorded round. */
  runCheck(copy: string): CheckRun {
    if (copy === "published") {
      if (!this.published) return { copy, error: "The seller has not published the result yet.", changes: [] };
      return this.#check(copy, this.published.disclosure, this.published.result);
    }
    const broken = this.brokenCopies().find((c) => c.name === copy);
    if (!broken) return { copy, error: "There is no tampered copy with that name.", changes: [] };
    const dir = join(this.#cfg.brokenDir, broken.name);
    const honest = readJson(join(this.#cfg.roundDir, "result.json"));
    const result = readJson(join(dir, "result.json"));
    const run = this.#check(copy, readJson(join(dir, "disclosure.json")), result);
    run.broken = broken;
    run.changes = numberChanges(honest, result);
    return run;
  }

  #check(copy: string, d: Disclosure, r: SellerResult): CheckRun {
    try {
      return { copy, verdict: checkLot(d, r), changes: [] };
    } catch (e) {
      if (e instanceof KeyRefusedError || e instanceof InputError) return { copy, error: e.message, changes: [] };
      return { copy, error: "Unexpected error while checking. Nothing was saved.", changes: [] };
    }
  }
}

/** Plain list of the numbers in the seller's result that differ between two copies. */
export function numberChanges(a: unknown, b: unknown, path = ""): string[] {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (typeof a === "number" && typeof b === "number") return a === b ? [] : [`${path || "value"}: ${fmt(a)} became ${fmt(b)}`];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    if (a.length !== b.length) out.push(`${path || "list"}: ${a.length} entries became ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...numberChanges(a[i], b[i], `${path}[${i + 1}]`));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out: string[] = [];
    for (const k of Object.keys(a as object)) {
      if (k in (b as object)) out.push(...numberChanges((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  return [];
}
