import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertViewingKey, checkLot, InputError, KeyRefusedError, type Verdict } from "./check.ts";
import { toHtml, toText } from "./report.ts";
import { assertNoSecret, LeakGuardError, maskDiscreet } from "./guard.ts";
import { blocksInRange, ScanInputError, validateChainFile, type BlockSource } from "./scan/chain.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange, type BidderKey, type ScanInput } from "./scan/scan.ts";
import { lookupBid } from "./mine.ts";
import { BlockFetchError, fetchBlocks } from "./scan/fetch-blocks.ts";
import { parseServer } from "./fetch/grpc.ts";
import { EXPLORER_PREFIX } from "./fetch/explorer.ts";
import { ZEBRA_PREFIX, isZebra, loadZebraAuth } from "./fetch/zebra.ts";
import { bidderCheck, bidderRange, bidderText, validateFacts, type BidClaim, type PublishedResult } from "./bidder.ts";
import { LinkingInputError, linkingFromLots, linkingText, lotRefunds } from "./privacy/linking.ts";

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
  --server <url>         with --fetch: ask this light server instead of the public ones (repeat, or comma-separate; one server is trusted alone, two or more must agree).
                         zebra+http://127.0.0.1:8232 reads blocks from your own Zebra node (zebra+http://127.0.0.1:18232 for testnet)
  --zebra-auth-file <f>  with a zebra+ server: file holding the node password (Zebra's .cookie file, or user:password); or set IMANI_ZEBRA_AUTH
  --concurrency <n>      with --fetch: blocks downloaded at the same time (default 12)

Exit code: 0 PASS, 1 FAIL, 2 refused or bad input.

       imani linking <lot disclosure.json> [more disclosures...]

  Shows how far each refund can be followed by anyone with the lot key, inside one round and
  across the rounds given. Exit code: 0 no links outside a round, 1 links found, 2 bad input.

       imani bidder-check --facts <lot facts.json> --key-file <your viewing key file> [options]

  Confirms your own bid landed and your refund is right, using only your own viewing key and
  public chain data. No seller file is needed. Options:
  --bid <txid>[:<zat>]   a bid to check (repeat for more). Without it, every bid your key can read
  --result <file>        optional: the seller's published result, to compare with it as well
  --chain <file>         read the blocks from this chain file (offline)
  --fetch                download the blocks from public light servers (two operators must agree)
  --grace, --proxy, --server, --zebra-auth-file, --concurrency   as for check
  Exit code: 0 PASS, 1 FAIL, 3 NOT PROVEN (nothing wrong, but your key alone cannot settle it), 2 bad input.`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

type Opts = Record<string, string | boolean>;
const FLAGS = new Set(["--basic", "--discreet", "--offline", "--scan", "--fetch"]);
const VALUES = new Set(["--disclosure", "--result", "--out", "--chain", "--grace", "--bidder-keys", "--proxy", "--server", "--concurrency", "--mine", "--zebra-auth-file"]);

/**
 * Read --server values (repeatable, or comma-separated) into a list of light server addresses.
 * Throws InputError for anything that is not https:// or http:// host[:port]. One server you run
 * yourself is trusted without a second opinion; two or more must agree, as with the defaults.
 */
export function parseServerList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (list.length === 0) throw new InputError("Input error: --server needs an address such as https://my-node.example:9067.");
  for (const s of list) {
    try {
      parseServer(s.startsWith(EXPLORER_PREFIX) ? s.slice(EXPLORER_PREFIX.length) : s.startsWith(ZEBRA_PREFIX) ? s.slice(ZEBRA_PREFIX.length) : s);
    } catch {
      throw new InputError(`Input error: --server "${s.slice(0, 80)}" is not a server address. Use https://host:port (or http:// for a node on your own machine), nothing after the port.`);
    }
  }
  return [...new Set(list)];
}

/** Fetch options for --server: the chosen servers, and no cross-check when there is only one. */
function serverOpts(raw: string | undefined, authFile?: string): { servers?: string[]; crossCheck?: boolean; zebraAuth?: string } {
  const servers = parseServerList(raw);
  if (!servers) return {};
  let zebraAuth: string | undefined;
  if (servers.some(isZebra)) {
    try {
      zebraAuth = loadZebraAuth(authFile);
    } catch (e) {
      throw new InputError(`Input error: ${(e as Error).message}.`);
    }
  }
  return { servers, crossCheck: servers.length > 1, zebraAuth };
}

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
    else if (a === "--server" && rest[i + 1] && !rest[i + 1].startsWith("--")) {
      const v = rest[++i];
      opts.server = typeof opts.server === "string" ? `${opts.server},${v}` : v;
    } else if (VALUES.has(a) && rest[i + 1] && !rest[i + 1].startsWith("--")) opts[a.slice(2)] = rest[++i];
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
  if (!opts.fetch && (opts.proxy || opts.concurrency || opts.server || opts["zebra-auth-file"])) return { code: 2, stdout: "", stderr: `--proxy, --server, --zebra-auth-file and --concurrency only apply with --fetch.${none}` };
  try {
    parseServerList(opts.server as string | undefined);
  } catch (e) {
    return { code: 2, stdout: "", stderr: `${(e as Error).message}${none}` };
  }
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
  if (argv[0] === "linking") return runLinking(argv.slice(1));
  if (argv[0] === "bidder-check") return runBidder(argv.slice(1));
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

interface BidderOpts {
  facts: string;
  keyFile: string;
  bids: BidClaim[];
  result?: string;
  chain?: string;
  fetch: boolean;
  grace?: string;
  proxy?: string;
  server?: string;
  concurrency?: string;
  zebraAuthFile?: string;
}

function parseBidder(args: string[]): BidderOpts | CliResult {
  const none = "\nServers contacted: none";
  const o: BidderOpts = { facts: "", keyFile: "", bids: [], fetch: false };
  const values: Record<string, "facts" | "keyFile" | "result" | "chain" | "grace" | "proxy" | "server" | "concurrency" | "zebraAuthFile"> = {
    "--facts": "facts", "--key-file": "keyFile", "--result": "result", "--chain": "chain", "--grace": "grace", "--proxy": "proxy", "--server": "server", "--concurrency": "concurrency", "--zebra-auth-file": "zebraAuthFile",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--fetch") o.fetch = true;
    else if (a === "--bid" && next && !next.startsWith("--")) {
      const m = /^([0-9a-fA-F]{64})(?::(\d+))?$/.exec(next);
      if (!m) return { code: 2, stdout: "", stderr: `--bid needs a 64 character transaction id, optionally followed by :<amount in zatoshis>.${none}` };
      const amountZat = m[2] === undefined ? undefined : Number(m[2]);
      if (amountZat !== undefined && !Number.isSafeInteger(amountZat)) return { code: 2, stdout: "", stderr: `--bid amount is too large.${none}` };
      o.bids.push({ txid: m[1].toLowerCase(), amountZat });
      i++;
    } else if (a === "--server" && next && !next.startsWith("--")) {
      o.server = o.server ? `${o.server},${next}` : next;
      i++;
    } else if (values[a] && next && !next.startsWith("--")) {
      o[values[a]] = next as never;
      i++;
    } else return { code: 2, stdout: "", stderr: `Unknown or incomplete option: ${a}\n\n${USAGE}` };
  }
  if (!o.facts || !o.keyFile) return { code: 2, stdout: "", stderr: USAGE };
  if (o.fetch && o.chain) return { code: 2, stdout: "", stderr: `Give either --chain (offline) or --fetch (online), not both.${none}` };
  if (!o.fetch && !o.chain) return { code: 2, stdout: "", stderr: `The bidder check needs blocks: give --chain <file> to read them offline, or --fetch to download them from public light servers.${none}` };
  if (!o.fetch && (o.proxy || o.concurrency || o.server || o.zebraAuthFile)) return { code: 2, stdout: "", stderr: `--proxy, --server, --zebra-auth-file and --concurrency only apply with --fetch.${none}` };
  try {
    parseServerList(o.server);
  } catch (e) {
    return { code: 2, stdout: "", stderr: `${(e as Error).message}${none}` };
  }
  return o;
}

/** The key file is the viewing key as plain text, or JSON with a "ufvk" field. It is never printed. */
function readKeyFile(path: string, network: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new InputError(`Input error: cannot read the key file at ${path}.`);
  }
  if (text.startsWith("{")) {
    try {
      text = String(JSON.parse(text).ufvk ?? "");
    } catch {
      throw new InputError("Input error: the key file is not valid JSON.");
    }
  }
  return assertViewingKey(text, network);
}

function bidderFinish(o: BidderOpts, facts: any, ufvk: string, blocks: any, missing: number[], source: BlockSource, grace: number): CliResult {
  let published: PublishedResult | undefined;
  if (o.result) {
    const r = readJson(o.result, "result") as any;
    if (!r || !Array.isArray(r.bids) || !Array.isArray(r.refunds)) throw new InputError("Input error: the seller result file needs bids and refunds lists.");
    published = r;
  }
  const rep = bidderCheck({ facts, ufvk, blocks, missing, source, graceBlocks: grace, bids: o.bids, published });
  const text = bidderText(rep);
  assertNoSecret(text, "the bidder report");
  return { code: rep.result === "PASS" ? 0 : rep.result === "FAIL" ? 1 : 3, stdout: text, stderr: "" };
}

function loadBidderInputs(o: BidderOpts) {
  const facts = readJson(o.facts, "lot facts") as any;
  validateFacts(facts);
  const ufvk = readKeyFile(o.keyFile, facts.network);
  const gOpts: Opts = o.grace === undefined ? {} : { grace: o.grace };
  return { facts, ufvk, grace: graceOf(gOpts) };
}

/** Read the bidder check's blocks from a chain file. */
function bidderBlocksFromFile(path: string, facts: any, grace: number) {
  const range = bidderRange(facts, grace);
  const chain = readJson(path, "chain") as any;
  validateChainFile(chain);
  if (chain.network !== facts.network) throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the lot facts say ${facts.network}.`);
  const started = Date.now();
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  const source: BlockSource = { kind: "chain-file", label: `the chain file ${basename(path)} (offline)`, serversContacted: [], bytes: 0, ms: Date.now() - started };
  return { blocks, missing, source };
}

function runBidder(args: string[]): CliResult {
  const o = parseBidder(args);
  if ("code" in o) return o;
  if (o.fetch) return { code: 2, stdout: "", stderr: "--fetch downloads blocks and needs runAsync.\nServers contacted: none" };
  try {
    const { facts, ufvk, grace } = loadBidderInputs(o);
    const scan = bidderBlocksFromFile(o.chain!, facts, grace);
    return bidderFinish(o, facts, ufvk, scan.blocks, scan.missing, scan.source, grace);
  } catch (e) {
    return failure(e, []);
  }
}

async function runBidderAsync(args: string[], progress?: (line: string) => void): Promise<CliResult> {
  const o = parseBidder(args);
  if ("code" in o || !o.fetch) return runBidder(args);
  let servers: string[] = [];
  try {
    const { facts, ufvk, grace } = loadBidderInputs(o);
    const range = bidderRange(facts, grace);
    const concurrency = o.concurrency === undefined ? undefined : Number(o.concurrency);
    if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)) {
      throw new InputError("Input error: --concurrency must be a whole number from 1 to 32.");
    }
    progress?.(`Downloading ${range.to - range.from + 1} blocks (${range.from} to ${range.to}) from ${o.server ? "your chosen server" : "public light servers"}. Your key is not sent.`);
    let fetched;
    try {
      fetched = await fetchBlocks({ network: facts.network, from: range.from, to: range.to, proxy: o.proxy, concurrency, ...serverOpts(o.server, o.zebraAuthFile) });
    } catch (e) {
      if (e instanceof BlockFetchError) servers = e.serversContacted;
      throw e;
    }
    servers = fetched.source.serversContacted;
    return bidderFinish(o, facts, ufvk, fetched.blocks, [], fetched.source, grace);
  } catch (e) {
    return failure(e, servers);
  }
}

function runLinking(files: string[]): CliResult {
  const none = "\nServers contacted: none";
  if (files.length === 0 || files.some((f) => f.startsWith("--"))) return { code: 2, stdout: "", stderr: USAGE };
  try {
    const lots = files.map((f) => {
      const d = readJson(f, "disclosure") as any;
      if (!d || typeof d.lotId !== "string" || !Array.isArray(d.transactions)) throw new InputError(`Input error: ${basename(f)} is not a lot disclosure file.`);
      if (d.ufvk !== undefined) assertViewingKey(d.ufvk, d.network);
      return lotRefunds(d);
    });
    // Two rounds may share a lot name. The same round given twice shares its payments.
    const keys = lots.map((l) => [...l.bids, ...l.refunds.map((f) => f.bidTxid + f.receiver)].sort().join(","));
    const twice = lots.find((_, i) => keys.indexOf(keys[i]) !== i);
    if (twice) return { code: 2, stdout: "", stderr: `Input error: lot ${twice.lotId} was given twice.${none}` };
    const rep = linkingFromLots(lots);
    const text = linkingText(rep);
    assertNoSecret(text, "the linking report");
    return { code: rep.linksOutside === 0 ? 0 : 1, stdout: text, stderr: "" };
  } catch (e) {
    if (e instanceof LinkingInputError || e instanceof InputError || e instanceof KeyRefusedError) return { code: 2, stdout: "", stderr: `${e.message}${none}` };
    throw e;
  }
}

/** Same as run, and also handles --fetch. `progress` gets one line now and then while blocks download. */
export async function runAsync(argv: string[], progress?: (line: string) => void): Promise<CliResult> {
  if (argv[0] === "bidder-check") return runBidderAsync(argv.slice(1), progress);
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
    progress?.(`Downloading ${total} blocks (${range.from} to ${range.to}) from ${opts.server ? "your chosen server" : "public light servers"}. No key is sent.`);
    let lastPct = -1;
    let fetched;
    try {
      fetched = await fetchBlocks({
        network: d.network,
        from: range.from,
        to: range.to,
        proxy: typeof opts.proxy === "string" ? opts.proxy : undefined,
        ...serverOpts(typeof opts.server === "string" ? opts.server : undefined, typeof opts["zebra-auth-file"] === "string" ? (opts["zebra-auth-file"] as string) : undefined),
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
