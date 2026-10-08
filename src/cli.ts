import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertViewingKey, checkLot, InputError, KeyRefusedError, type Verdict } from "./check.ts";
import { toHtml, toText } from "./report.ts";
import { assertNoSecret, LeakGuardError, maskDiscreet } from "./guard.ts";
import { blocksInRange, ScanInputError, validateChainFile, type BlockSource } from "./scan/chain.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange, type BidderKey, type ScanInput } from "./scan/scan.ts";
import { lookupBid } from "./mine.ts";
import { BlockFetchError, fetchBlocks } from "./scan/fetch-blocks.ts";

const USAGE = `Usage: imani check --disclosure <lot disclosure.json> --result <seller result.json> [options]

  --basic        run only the checks that need no key
  --discreet     hide amounts, memos and addresses in everything printed or written
  --offline      never open a network connection (refuses --fetch)
  --out          also write verdict.json and report.html into this folder
  --mine <txid>  also answer "was my bid counted?" for the bid with this transaction id

Scan level (reads every block from the lot's open height to its refund deadline):
  --scan                 run the scan level
  --chain <file>         read the blocks from this chain file (offline, the default way)
  --fetch                download the blocks from public light servers instead (online, opt-in)
  --grace <blocks>       read at least this many blocks past the close (default ${DEFAULT_GRACE_BLOCKS})
  --bidder-keys <file>   bidders' own viewing keys, to prove their refunds reached them
  --proxy <url>          with --fetch: SOCKS5 proxy, for example socks5h://127.0.0.1:9050 (Tor)
  --concurrency <n>      with --fetch: blocks downloaded at the same time (default 12)

Exit code: 0 PASS, 1 FAIL, 2 refused or bad input.`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Opts = Record<string, string | boolean>;
const FLAGS = new Set(["--basic", "--discreet", "--offline", "--scan", "--fetch"]);
const VALUES = new Set(["--disclosure", "--result", "--out", "--chain", "--grace", "--bidder-keys", "--proxy", "--concurrency", "--mine"]);

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`Input error: cannot read the ${what} file at ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`Input error: the ${what} file is not valid JSON.`);
  }
}

function parse(argv: string[]): Opts | CliResult {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") return { code: 2, stdout: "", stderr: USAGE };
  const opts: Opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (FLAGS.has(a)) opts[a.slice(2)] = true;
    else if (VALUES.has(a) && rest[i + 1] && !rest[i + 1].startsWith("--")) opts[a.slice(2)] = rest[++i];
    else return { code: 2, stdout: "", stderr: `Unknown or incomplete option: ${a}\n\n${USAGE}` };
  }
  if (typeof opts.disclosure !== "string" || typeof opts.result !== "string") return { code: 2, stdout: "", stderr: USAGE };
  const none = "\nServers contacted: none";
  if (!opts.scan && (opts.chain || opts.fetch || opts.grace || opts["bidder-keys"])) {
    return { code: 2, stdout: "", stderr: `--chain, --fetch, --grace and --bidder-keys need --scan.${none}` };
  }
  if (opts.offline && opts.fetch) return { code: 2, stdout: "", stderr: `--offline and --fetch cannot be combined. --offline never opens a network connection.${none}` };
  if (opts.scan && opts.fetch && opts.chain) return { code: 2, stdout: "", stderr: `Give either --chain (offline) or --fetch (online), not both.${none}` };
  if (opts.scan && !opts.fetch && !opts.chain) {
    return { code: 2, stdout: "", stderr: `The scan needs blocks: give --chain <file> to read them offline, or --fetch to download them from public light servers.${none}` };
  }
  if (!opts.fetch && (opts.proxy || opts.concurrency)) return { code: 2, stdout: "", stderr: `--proxy and --concurrency only apply with --fetch.${none}` };
  return opts;
}

const isResult = (x: Opts | CliResult): x is CliResult => typeof (x as CliResult).code === "number";

function graceOf(opts: Opts): number {
  if (opts.grace === undefined) return DEFAULT_GRACE_BLOCKS;
  const n = Number(opts.grace);
  if (!Number.isSafeInteger(n) || n < 0) throw new InputError("Input error: --grace must be a whole number of blocks.");
  return n;
}

function bidderKeys(opts: Opts, network: string): BidderKey[] | undefined {
  if (typeof opts["bidder-keys"] !== "string") return undefined;
  const f = readJson(opts["bidder-keys"], "bidder keys") as any;
  if (!f || f.format !== "imani-bidder-keys/1" || !Array.isArray(f.keys) || f.keys.length === 0) {
    throw new InputError('Input error: the bidder keys file must have "format": "imani-bidder-keys/1" and a non-empty keys list.');
  }
  return f.keys.map((k: any) => {
    if (!k || typeof k.bidTxid !== "string" || !/^[0-9a-f]{64}$/.test(k.bidTxid)) {
      throw new InputError("Input error: every bidder key needs the bidTxid of that bidder's bid (64 hex characters).");
    }
    return { bidTxid: k.bidTxid, ufvk: assertViewingKey(k.ufvk, network) };
  });
}

/** The core: run the checks and write the outputs. Never contacts a server. */
function finish(opts: Opts, d: any, r: any, scan?: ScanInput): CliResult {
  const v: Verdict = checkLot(d, r, { basicOnly: !!opts.basic, discreet: !!opts.discreet, scan });
  let stdout = toText(v);
  if (typeof opts.mine === "string") stdout += "\n\n" + lookupBid(r, v, opts.mine);
  let json = JSON.stringify(v, null, 2) + "\n";
  let html = toHtml(v);
  if (v.discreet) {
    stdout = maskDiscreet(stdout);
    json = maskDiscreet(json);
    html = maskDiscreet(html);
  }
  // Nothing shaped like a key or seed phrase leaves, in any output. Checked before any file is written.
  assertNoSecret(stdout, "the printed result");
  assertNoSecret(json, "verdict.json");
  assertNoSecret(html, "report.html");
  if (typeof opts.out === "string") {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, "verdict.json"), json);
    writeFileSync(join(opts.out, "report.html"), html);
    stdout += `\nWrote ${join(opts.out, "verdict.json")} and ${join(opts.out, "report.html")}`;
  }
  return { code: v.result === "PASS" ? 0 : 1, stdout, stderr: "" };
}

function failure(e: unknown, servers: string[]): CliResult {
  const line = `Servers contacted: ${servers.length ? servers.join(", ") : "none"}`;
  if (e instanceof KeyRefusedError || e instanceof LeakGuardError || e instanceof InputError || e instanceof ScanInputError) {
    return { code: 2, stdout: "", stderr: `${e.message}\n${line}` };
  }
  if (e instanceof BlockFetchError) {
    return { code: 2, stdout: "", stderr: `Could not run the scan: ${e.message}. Nothing was written.\n${line}` };
  }
  // Unknown errors: show a fixed message so nothing from the input can leak into the output.
  return { code: 2, stdout: "", stderr: `Unexpected error while checking. Nothing was written.\n${line}` };
}

/** Read the blocks of the lot's range from a chain file on disk. */
function scanFromChainFile(opts: Opts, d: any): ScanInput {
  const range = scanRange(d, graceOf(opts));
  const chain = readJson(opts.chain as string, "chain") as any;
  validateChainFile(chain);
  if (chain.network !== d.network) throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the disclosure says ${d.network}.`);
  const started = Date.now();
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  let bytes = 0;
  for (const b of blocks) for (const t of b.txs) bytes += t.txHex.length / 2;
  const source: BlockSource = {
    kind: "chain-file",
    label: `the chain file ${basename(opts.chain as string)} (offline)`,
    serversContacted: [],
    bytes,
    ms: Date.now() - started,
  };
  return { blocks, missing, source, graceBlocks: range.graceBlocks, bidderKeys: bidderKeys(opts, d.network) };
}

/**
 * Runs the command and returns what it would print. Offline only: a --fetch run needs
 * runAsync. Never prints the lot key, never writes it.
 */
export function run(argv: string[]): CliResult {
  const opts = parse(argv);
  if (isResult(opts)) return opts;
  if (opts.fetch) return { code: 2, stdout: "", stderr: "--fetch downloads blocks and needs runAsync.\nServers contacted: none" };
  try {
    const d = readJson(opts.disclosure as string, "disclosure") as any;
    const r = readJson(opts.result as string, "result") as any;
    return finish(opts, d, r, opts.scan ? scanFromChainFile(opts, d) : undefined);
  } catch (e) {
    return failure(e, []);
  }
}

/** Same as run, and also handles --fetch. `progress` gets one line now and then while blocks download. */
export async function runAsync(argv: string[], progress?: (line: string) => void): Promise<CliResult> {
  const opts = parse(argv);
  if (isResult(opts) || !opts.fetch) return run(argv);
  let servers: string[] = [];
  try {
    const d = readJson(opts.disclosure as string, "disclosure") as any;
    const r = readJson(opts.result as string, "result") as any;
    // Refuse bad files or a bad key before any connection is opened.
    checkLot(d, r, { basicOnly: true });
    if (!opts.basic && d.ufvk) assertViewingKey(d.ufvk, d.network);
    const keys = bidderKeys(opts, d.network);
    const range = scanRange(d, graceOf(opts));
    const concurrency = opts.concurrency === undefined ? undefined : Number(opts.concurrency);
    if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)) {
      throw new InputError("Input error: --concurrency must be a whole number from 1 to 32.");
    }
    const total = range.to - range.from + 1;
    progress?.(`Downloading ${total} blocks (${range.from} to ${range.to}) from public light servers. No key is sent.`);
    let lastPct = -1;
    let fetched;
    try {
      fetched = await fetchBlocks({
        network: d.network,
        from: range.from,
        to: range.to,
        proxy: typeof opts.proxy === "string" ? opts.proxy : undefined,
        concurrency,
        onProgress: (done, all) => {
          const pct = Math.floor((done / all) * 100);
          if (pct !== lastPct && (pct % 5 === 0 || done === all)) progress?.(`  ${done} of ${all} blocks (${pct}%)`);
          lastPct = pct;
        },
      });
    } catch (e) {
      if (e instanceof BlockFetchError) servers = e.serversContacted;
      throw e;
    }
    servers = fetched.source.serversContacted;
    return finish(opts, d, r, { blocks: fetched.blocks, missing: [], source: fetched.source, graceBlocks: range.graceBlocks, bidderKeys: keys });
  } catch (e) {
    return failure(e, servers);
  }
}

export async function main(argv: string[]): Promise<void> {
  const res = await runAsync(argv, (line) => process.stderr.write(line + "\n"));
  if (res.stdout) process.stdout.write(res.stdout + "\n");
  if (res.stderr) process.stderr.write(res.stderr + "\n");
  process.exitCode = res.code;
}
