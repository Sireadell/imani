// `imani bid-proof make` and `imani bid-proof check`: prove one bid to someone who holds no
// viewing key. See docs/BID_PROOF.md.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { assertViewingKey, InputError, KeyRefusedError } from "./check.ts";
import { validateFacts } from "./bidder.ts";
import { assertNoSecret, LeakGuardError } from "./guard.ts";
import { validateChainFile, ScanInputError, type ChainFile } from "./scan/chain.ts";
import { checkTxBytes, TXID_RE } from "./fetch/verify.ts";
import { fetchTransactions, FetchError } from "./fetch/index.ts";
import { hostOf } from "./fetch/servers.ts";
import { parseServerList } from "./cli.ts";
import { BidProofError, bidProofText, makeBidProof, validateBidProof, verifyBidProof, type BidProof, type MinedAt } from "./bid-proof.ts";

export interface BidProofCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const BID_PROOF_USAGE = `Usage: imani bid-proof make --facts <lot facts.json> --key-file <viewing key file> --bid <txid> (--disclosure <file> | --chain <file> | --fetch) [--result <file>] [--out <proof.json>]
       imani bid-proof check --proof <proof.json> [--facts <lot facts.json>] [--result <seller result.json>] [--chain <file> | --fetch]

  make   writes a proof that one bid was paid to the lot, with its amount and memo. Use the lot's
         viewing key (the lot owner issues the proof) or the bidder's own key, if their wallet kept a
         copy of what it sent. The key is used on this machine and never written into the proof.
         The bid transaction comes from the seller's disclosure file, a chain file, or two public servers.
  check  checks a proof with no viewing key. Give the seller's published lot facts and result to
         confirm the lot and that the bid was counted, and --chain or --fetch to confirm its block.
  --server, --proxy   with --fetch, as for imani check
  Exit code: 0 PASS, 1 FAIL, 3 NOT PROVEN (nothing wrong found, but some lines rest on the proof file), 2 bad input.`;

const VALUES = ["--facts", "--key-file", "--bid", "--disclosure", "--chain", "--result", "--out", "--proof", "--server", "--proxy"];

function options(args: string[]): Record<string, string | boolean> | string {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fetch") o.fetch = true;
    else if (VALUES.includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      const k = a.slice(2);
      o[k] = k === "server" && typeof o.server === "string" ? `${o.server},${args[++i]}` : args[++i];
    } else return `Unknown or incomplete option: ${a}`;
  }
  return o;
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new InputError(`Input error: cannot read the ${what} file at ${path}.`);
  }
}
function readJson(path: string, what: string): any {
  const text = readText(path, what);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`Input error: the ${what} file is not valid JSON.`);
  }
}

/** The key file is the viewing key as plain text, or JSON with a "ufvk" field. It is never printed. */
function readKey(path: string, network: string): string {
  let text = readText(path, "key").trim();
  if (text.startsWith("{")) {
    try {
      text = String(JSON.parse(text).ufvk ?? "");
    } catch {
      throw new InputError("Input error: the key file is not valid JSON.");
    }
  }
  return assertViewingKey(text, network);
}

function failure(e: unknown, servers: string[]): BidProofCliResult {
  const line = `Servers contacted: ${servers.length ? servers.join(", ") : "none"}`;
  if (e instanceof InputError || e instanceof KeyRefusedError || e instanceof LeakGuardError || e instanceof ScanInputError || e instanceof BidProofError) {
    return { code: 2, stdout: "", stderr: `${e.message}\n${line}` };
  }
  if (e instanceof FetchError) return { code: 2, stdout: "", stderr: `Could not download the transaction: ${e.message}\n${line}` };
  return { code: 2, stdout: "", stderr: `Unexpected error. Nothing was written.\n${line}` };
}

/** Find a transaction in a chain file: its block and bytes. */
function fromChain(path: string, network: string, txid: string): { height: number; txHex: string } | null {
  const chain = readJson(path, "chain") as ChainFile;
  validateChainFile(chain);
  if (chain.network !== network) throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the lot is on ${network}.`);
  for (const b of chain.blocks) for (const t of b.txs) if (t.txid.toLowerCase() === txid) return { height: b.height, txHex: t.txHex.toLowerCase() };
  return null;
}

function minedFromChain(path: string, proof: BidProof): MinedAt {
  const source = `the chain file ${basename(path)} (offline)`;
  const hit = fromChain(path, proof.lot.network, proof.bid.txid);
  if (!hit) return { height: null, found: false, source, serversContacted: [] };
  if (checkTxBytes(hit.txHex, proof.bid.txid)) throw new ScanInputError(`Input error: the chain file lists ${proof.bid.txid.slice(0, 10)} with bytes that are another transaction.`);
  return { height: hit.height, found: true, source, serversContacted: [] };
}

async function fetchOne(o: Record<string, string | boolean>, network: "main" | "test", txid: string) {
  const servers = parseServerList(typeof o.server === "string" ? o.server : undefined);
  const res = await fetchTransactions({
    network,
    txids: [txid],
    proxy: typeof o.proxy === "string" ? o.proxy : undefined,
    ...(servers ? { servers, crossCheck: servers.length > 1 } : {}),
  });
  return { tx: res.transactions.find((t) => t.txid === txid), serversContacted: res.serversContacted };
}

const bad = (msg: string): BidProofCliResult => ({ code: 2, stdout: "", stderr: `${msg}\n\n${BID_PROOF_USAGE}\nServers contacted: none` });

function sources(o: Record<string, string | boolean>, allowDisclosure: boolean): string | null {
  const given = ["disclosure", "chain", "fetch"].filter((k) => o[k] !== undefined && (allowDisclosure || k !== "disclosure"));
  if (!allowDisclosure && o.disclosure !== undefined) return "--disclosure is only for make.";
  if (given.length > 1) return `Give only one of ${allowDisclosure ? "--disclosure, " : ""}--chain and --fetch.`;
  if (!o.fetch && (o.server !== undefined || o.proxy !== undefined)) return "--server and --proxy only apply with --fetch.";
  try {
    parseServerList(typeof o.server === "string" ? o.server : undefined);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

function writeProof(o: Record<string, string | boolean>, proof: BidProof, serversContacted: string[]): BidProofCliResult {
  const text = JSON.stringify(proof, null, 2) + "\n";
  assertNoSecret(text, "the bid proof");
  const out = typeof o.out === "string" ? o.out : `bid-proof-${proof.bid.txid.slice(0, 10)}.json`;
  try {
    writeFileSync(out, text);
  } catch {
    throw new InputError(`Input error: cannot write ${out}.`);
  }
  const { bid } = proof;
  return {
    code: 0,
    stdout: [
      `Wrote ${out}: a proof of bid ${bid.txid} in lot ${proof.lot.lotId}, ${bid.amountZat.toLocaleString("en-US")} zat, memo "${bid.memo}", block ${bid.height}.`,
      "It opens this one payment and no other. It holds no viewing key. Anyone you give it to can run:",
      `  imani bid-proof check --proof ${out} --facts <lot facts> --result <seller result> --fetch`,
      `Servers contacted: ${serversContacted.length ? serversContacted.join(", ") : "none"}`,
    ].join("\n"),
    stderr: "",
  };
}

function makeInputs(o: Record<string, string | boolean>) {
  if (typeof o.facts !== "string" || typeof o["key-file"] !== "string" || typeof o.bid !== "string") return "make needs --facts, --key-file and --bid.";
  if (!TXID_RE.test(o.bid.toLowerCase())) return "--bid needs the bid's 64 character transaction id.";
  if (o.disclosure === undefined && o.chain === undefined && !o.fetch) return "make needs the bid transaction: give --disclosure <seller's disclosure file>, --chain <file> or --fetch.";
  return sources(o, true);
}

function loadMake(o: Record<string, string | boolean>) {
  const facts = readJson(o.facts as string, "lot facts");
  validateFacts(facts);
  const viewingKey = readKey(o["key-file"] as string, facts.network);
  const resultFile = typeof o.result === "string" ? readText(o.result, "result") : undefined;
  return { facts, viewingKey, resultFile, txid: (o.bid as string).toLowerCase() };
}

function runMake(o: Record<string, string | boolean>): BidProofCliResult {
  const problem = makeInputs(o);
  if (problem) return bad(problem);
  if (o.fetch) return { code: 2, stdout: "", stderr: "--fetch downloads the transaction and needs runAsync.\nServers contacted: none" };
  try {
    const m = loadMake(o);
    let hit: { height: number; txHex: string } | null = null;
    if (typeof o.disclosure === "string") {
      const d = readJson(o.disclosure, "disclosure");
      const t = Array.isArray(d?.transactions) ? d.transactions.find((x: any) => String(x?.txid ?? "").toLowerCase() === m.txid) : undefined;
      if (t && typeof t.txHex === "string" && Number.isSafeInteger(t.height)) hit = { height: t.height, txHex: t.txHex.toLowerCase() };
    } else hit = fromChain(o.chain as string, m.facts.network, m.txid);
    if (!hit) throw new BidProofError(`Transaction ${m.txid.slice(0, 10)} is not in ${typeof o.disclosure === "string" ? "the disclosure file" : "the chain file"}.`);
    return writeProof(o, makeBidProof({ ...m, txHex: hit.txHex, height: hit.height }), []);
  } catch (e) {
    return failure(e, []);
  }
}

async function runMakeFetch(o: Record<string, string | boolean>): Promise<BidProofCliResult> {
  let servers: string[] = [];
  try {
    const m = loadMake(o);
    let got;
    try {
      got = await fetchOne(o, m.facts.network, m.txid);
    } catch (e) {
      if (e instanceof FetchError) servers = e.serversContacted;
      throw e;
    }
    servers = got.serversContacted;
    if (!got.tx) throw new BidProofError(`The servers did not return transaction ${m.txid.slice(0, 10)}.`);
    if (got.tx.height === undefined) throw new BidProofError(`The servers returned transaction ${m.txid.slice(0, 10)} but not the block that mined it. Use --chain or --disclosure.`);
    return writeProof(o, makeBidProof({ ...m, txHex: got.tx.hex, height: got.tx.height }), servers);
  } catch (e) {
    return failure(e, servers);
  }
}

function loadCheck(o: Record<string, string | boolean>) {
  const proof = readJson(o.proof as string, "bid proof");
  validateBidProof(proof);
  let facts;
  if (typeof o.facts === "string") {
    facts = readJson(o.facts, "lot facts");
    validateFacts(facts);
  }
  const resultBytes = typeof o.result === "string" ? readText(o.result, "result") : undefined;
  let result;
  if (resultBytes !== undefined) {
    try {
      result = JSON.parse(resultBytes);
    } catch {
      throw new InputError("Input error: the result file is not valid JSON.");
    }
  }
  return { proof, facts, result, resultBytes };
}

function finishCheck(c: ReturnType<typeof loadCheck>, mined: MinedAt | undefined): BidProofCliResult {
  const rep = verifyBidProof(c.proof, { facts: c.facts, result: c.result, resultBytes: c.resultBytes, mined });
  const text = bidProofText(rep);
  assertNoSecret(text, "the bid proof report");
  return { code: rep.result === "PASS" ? 0 : rep.result === "FAIL" ? 1 : 3, stdout: text, stderr: "" };
}

function checkInputs(o: Record<string, string | boolean>) {
  if (typeof o.proof !== "string") return "check needs --proof <file>.";
  for (const k of ["key-file", "bid", "out"]) if (o[k] !== undefined) return `--${k} is only for make. A check never needs a key.`;
  return sources(o, false);
}

function runCheck(o: Record<string, string | boolean>): BidProofCliResult {
  const problem = checkInputs(o);
  if (problem) return bad(problem);
  if (o.fetch) return { code: 2, stdout: "", stderr: "--fetch downloads the transaction and needs runAsync.\nServers contacted: none" };
  try {
    const c = loadCheck(o);
    return finishCheck(c, typeof o.chain === "string" ? minedFromChain(o.chain, c.proof) : undefined);
  } catch (e) {
    return failure(e, []);
  }
}

async function runCheckFetch(o: Record<string, string | boolean>): Promise<BidProofCliResult> {
  let servers: string[] = [];
  try {
    const c = loadCheck(o);
    let got;
    try {
      got = await fetchOne(o, c.proof.lot.network, c.proof.bid.txid);
    } catch (e) {
      if (e instanceof FetchError) servers = e.serversContacted;
      throw e;
    }
    servers = got.serversContacted;
    const by = got.tx ? got.tx.confirmedBy.map(hostOf).join(" and ") : "the servers asked";
    const mined: MinedAt = { height: got.tx?.height ?? null, found: !!got.tx, source: by, serversContacted: servers };
    return finishCheck(c, mined);
  } catch (e) {
    return failure(e, servers);
  }
}

/** `imani bid-proof ...` without network access. */
export function runBidProof(args: string[]): BidProofCliResult {
  const [sub, ...rest] = args;
  const o = options(rest);
  if (typeof o === "string") return bad(o);
  if (sub === "make") return runMake(o);
  if (sub === "check") return runCheck(o);
  return bad("Say make or check: imani bid-proof make ... or imani bid-proof check ...");
}

/** Same as runBidProof, and also handles --fetch. */
export async function runBidProofAsync(args: string[]): Promise<BidProofCliResult> {
  const [sub, ...rest] = args;
  const o = options(rest);
  if (typeof o === "string" || !o.fetch) return runBidProof(args);
  if (sub === "make") {
    const problem = makeInputs(o);
    return problem ? bad(problem) : runMakeFetch(o);
  }
  if (sub === "check") {
    const problem = checkInputs(o);
    return problem ? bad(problem) : runCheckFetch(o);
  }
  return runBidProof(args);
}
