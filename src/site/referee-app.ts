// Screen code for the "check any round" page (check.html). The checking is in referee.ts and the
// checker it calls, the same code as the command line tool. This page makes network calls only
// after the reader presses the ask button, and only these: GET /api/block?network=...&height=...
// to the site it was loaded from. The saved-file path makes none. The lot key is never put in a
// request. It is read from the box, used in this tab, and not stored.
import { initReader } from "./engine.ts";
import { refereeRound, networkOfKey, type RefereeOutcome } from "./referee.ts";
import { askText } from "./ask.ts";
import { checkSavedRound, type RoundFields } from "./saved-round.ts";
import { savedRoundText } from "imani-saved-round";
import { assertViewingKey, KeyRefusedError, type Check } from "../check.ts";
import type { ChainBlock } from "../scan/chain.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const zat = (n: number) => `${n.toLocaleString("en-US")} zat (${(n / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0")} ZEC)`;
const short = (t: string) => `${t.slice(0, 10)}...`;

/** Imani's own real round on the Zcash test network (examples/testnet-01), a public test key. */
const EXAMPLE = {
  key: "uviewtest1vw42ldcedl6ndmlm3fek44a23dwv38x0re4w4jnyjgdp3yxf7f4w3afy9rvyyqeqexjapmz342uv4gx6w2tx9phwzdy00gj3xt9yhxp9f0ds4y7sagg6ed7w5tnv0lx75vutwlvs7s9cytspuvzrlxarpqwkpu59cuqv2cmntutglzy2g0r0tzqwfqcl9jtln86t079fv7ps5x0p2s8gclwr57hmekf276hah6zyjvq459m7deffclv963yjcemtrkv0xgk459ex0lkyz4pgnxca6yhjj7teyd32evf7dryjnjjvn3st4flzeucrz2lhsxs4gg9739d5pc2fkx5909k5qqulglzkw5krxx7cm263u7y4enj3lyv402nzx73hqukmw94uzv35uyqka02yyamfeex9d94rg40hkuut5h37hpjg52ajsvfez4jtcucrpdjdfm78cwwq3g6cyzs87rvka7npp8qs5wzlukud95yx8uaw7ywxej24",
  from: "4489077",
  to: "4489110",
  items: "2",
  reserve: "1000000",
  close: "4489085",
  lot: "",
};

const CONCURRENCY = 8;

/** Checks that compare the rebuilt files with themselves here, so they match by construction. */
const BY_CONSTRUCTION = new Set(["close-height", "disclosure-txids-unique", "result-consistent", "winner-count", "clearing-range", "bid-count", "bid-amounts", "winners-and-price", "reserve", "refund-total", "scan-hidden-bids", "scan-unlisted-payments", "scan-listed-in-range", "scan-heights", "no-late-bids"]);

interface BlockReply {
  height: number;
  txs: { txid: string; txHex: string }[];
  answers: { server: string; hash: string; txCount: number; digest: string }[];
  agree: boolean;
  serversContacted: string[];
}

class FetchProblem extends Error {}

const OFFLINE_HINT = "You can still check the round with no network at all: use a saved block file, below.";

async function getBlock(network: string, height: number): Promise<BlockReply> {
  let r: Response;
  try {
    r = await fetch(`/api/block?network=${network}&height=${height}`, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new FetchProblem(`Could not reach the site this page came from, so no block was fetched. ${OFFLINE_HINT}`);
  }
  const type = r.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new FetchProblem(`This copy of the page has no block relay behind it, so it cannot get blocks. ${OFFLINE_HINT} Or open the hosted page, or run node tools/referee-serve.ts and open the page from there.`);
  }
  const body = await r.json();
  if (!r.ok) throw new FetchProblem(`Block ${height} could not be fetched (${String(body.error ?? r.status).slice(0, 300)}). The public servers may be down or busy. ${OFFLINE_HINT}`);
  return body as BlockReply;
}

function showError(kind: string, message: string) {
  const out = $("result");
  out.replaceChildren();
  const b = el("div", `banner ${kind === "refused" ? "refused" : "error"}`);
  b.appendChild(el("div", "big", kind === "refused" ? "Refused" : "Could not check"));
  b.appendChild(el("p", undefined, message));
  out.appendChild(b);
}

function row(table: HTMLTableElement, cells: string[], head = false) {
  const tr = el("tr");
  for (const c of cells) tr.appendChild(el(head ? "th" : "td", undefined, c));
  table.appendChild(tr);
}

function render(o: Extract<RefereeOutcome, { ok: true }>, replies: BlockReply[] | null, ms: number, fileName = "") {
  const out = $("result");
  out.replaceChildren();
  const v = o.verdict;
  const r = o.round;
  const banner = el("div", `banner ${v.result === "PASS" ? "pass" : "fail"}`);
  banner.appendChild(el("div", "big", v.result === "PASS" ? "PASS: the round was run by the rules" : `FAIL: ${v.failed.length} check(s) found a problem`));
  banner.appendChild(
    el(
      "p",
      undefined,
      v.result === "PASS"
        ? `Lot ${r.lotId}. Every block was read with the lot key, and the refunds the lot paid match what the rules owe, to the zatoshi.`
        : `Lot ${r.lotId}. Failed: ${v.failed.join(", ")}.`,
    ),
  );
  out.appendChild(banner);

  out.appendChild(el("h3", undefined, "What the chain says, recomputed"));
  const t = el("table", "grid");
  row(t, ["", "Recomputed from the blocks"], true);
  row(t, ["Bids counted", `${r.bidCount}${r.lateBids ? ` (and ${r.lateBids} late or repeated, owed back in full)` : ""}`]);
  row(t, ["Reserve met", r.reserveMet ? "yes" : "no, so there are no winners"]);
  row(t, ["Clearing price", r.reserveMet ? `${zat(r.clearingPriceZat)} for each item` : "none"]);
  for (const w of r.winners) row(t, [`Winner`, `bid ${short(w.txid)} of ${zat(w.amountZat)}: pays ${zat(w.paysZat)}, gets back ${zat(w.refundZat)}`]);
  for (const l of r.losers) row(t, [`Did not win`, `bid ${short(l.txid)} of ${zat(l.amountZat)}: gets back all of it`]);
  out.appendChild(t);

  out.appendChild(el("h3", undefined, "Refunds: owed by the rules, paid on the chain"));
  const rt = el("table", "grid");
  row(rt, ["Bid", "Owed", "Paid", ""], true);
  for (const f of r.refunds) row(rt, [short(f.bidTxid), zat(f.owedZat), zat(f.paidZat), f.owedZat === f.paidZat ? "same" : "DIFFERENT"]);
  if (!r.refunds.length) row(rt, ["none owed", "", "", ""]);
  out.appendChild(rt);

  if (replies) renderServers(out, replies, ms);
  else {
    out.appendChild(el("h3", undefined, "Where the blocks came from"));
    out.appendChild(
      el(
        "p",
        "meta",
        `From the saved file ${fileName}, read in this tab in ${(ms / 1000).toFixed(1)} seconds. Nothing was requested. Every transaction's bytes were hashed here and matched to its id, so a changed transaction would show. A saved file can still leave a transaction out. A missing refund fails the check, but a small losing bid taken out together with its refund would not show. The live check closes that gap when the servers can be reached.`,
      ),
    );
  }
  renderChecks(out, o);
}

function renderServers(out: HTMLElement, replies: BlockReply[], ms: number) {
  out.appendChild(el("h3", undefined, "The two block servers"));
  const names = replies[0]?.answers.map((a) => a.server) ?? [];
  out.appendChild(
    el(
      "p",
      "meta",
      `Every block was asked of two servers run by different operators (${names.join(" and ") || "none"}). Both answers are below, block by block. A block is used only when both give the same block hash and the same list of transactions, and the bytes of every transaction hash to its id. Done in ${(ms / 1000).toFixed(1)} seconds.`,
    ),
  );
  const agreeAll = replies.every((x) => x.agree);
  out.appendChild(el("p", agreeAll ? "ok" : "bad", agreeAll ? `Both servers agree on all ${replies.length} blocks.` : "The servers disagreed on at least one block. See the table."));
  const det = el("details");
  det.appendChild(el("summary", undefined, `Show both answers for each of the ${replies.length} blocks`));
  const bt = el("table", "grid small");
  row(bt, ["Block", names[0] ?? "server A", names[1] ?? "server B", "Agree"], true);
  for (const x of replies) {
    const cell = (a?: { hash: string; txCount: number }) => (a ? `${a.txCount} tx, hash ${a.hash.slice(0, 12)}...` : "no answer");
    row(bt, [String(x.height), cell(x.answers[0]), cell(x.answers[1]), x.agree ? "yes" : "NO"]);
  }
  det.appendChild(bt);
  out.appendChild(det);
}

function renderChecks(out: HTMLElement, o: Extract<RefereeOutcome, { ok: true }>) {
  out.appendChild(el("h3", undefined, "Every check"));
  const list = el("div");
  const sorted: Check[] = [...o.verdict.checks];
  for (const c of sorted) {
    const d = el("details", `check ${c.status === "PASS" ? "pass" : "fail"}`);
    if (c.status === "FAIL") d.open = true;
    d.appendChild(el("summary", undefined, `${c.status}  ${c.title}${BY_CONSTRUCTION.has(c.id) ? " (matches by construction here)" : ""}`));
    d.appendChild(el("p", undefined, c.reason));
    list.appendChild(d);
  }
  out.appendChild(list);

  out.appendChild(el("h3", undefined, "What this check does not prove"));
  const ul = el("ul");
  ul.appendChild(el("li", undefined, "There is no seller list here to compare with. So 'the seller left out a bid' cannot be tested. A bid is missed only if it never reached this lot's address, which the key would show."));
  ul.appendChild(el("li", undefined, "The rules used are the ones you typed (items and reserve) and Imani's price rule: the highest bid that did not win sets the price, never below the reserve."));
  if (o.closeAssumed) ul.appendChild(el("li", undefined, "No close block was given, so every bid in the range counted as on time."));
  ul.appendChild(el("li", undefined, "Who a refund was sent to is not shown by the lot key alone, unless bidders wrote their refund address in the bid memo."));
  out.appendChild(ul);
}

/** The boxes, checked before anything else happens. Returns null after showing a message. */
function readFields(): RoundFields | null {
  const key = $<HTMLTextAreaElement>("f-key").value.trim();
  const num = (id: string) => Number($<HTMLInputElement>(id).value.replace(/[,\s]/g, ""));
  const closeText = $<HTMLInputElement>("f-close").value.trim();
  const lotText = $<HTMLInputElement>("f-lot").value.trim();
  const from = num("f-from");
  const to = num("f-to");
  $("result").replaceChildren();
  // Refuse a bad key before anything is asked or requested.
  try {
    assertViewingKey(key, networkOfKey(key));
  } catch (e) {
    showError(e instanceof KeyRefusedError ? "refused" : "error", e instanceof KeyRefusedError ? e.message : "The key could not be read.");
    return null;
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from + 1 > 5000) {
    showError("error", "Input error: the block range must be two whole numbers, the first not after the last, at most 5000 blocks.");
    return null;
  }
  return {
    key,
    from,
    to,
    itemCount: num("f-items"),
    reserveZat: num("f-reserve"),
    closeHeight: closeText === "" ? undefined : Number(closeText.replace(/[,\s]/g, "")),
    lotId: lotText === "" ? undefined : lotText,
  };
}

let pending: RoundFields | null = null;

/** Step one of a live check: say what would be contacted, and wait. Nothing is requested here. */
function ask() {
  hideAsk();
  const f = readFields();
  if (!f) return;
  pending = f;
  const t = askText(networkOfKey(f.key), location.host || "this page's own site", f.from, f.to);
  $("ask-body").textContent = t.body;
  $("btn-consent").textContent = t.button;
  $("ask").hidden = false;
  $("btn-consent").focus();
}

function hideAsk() {
  pending = null;
  $("ask").hidden = true;
}

/** Step two, reached only from the ask button: request the blocks and check. */
async function fetchBlocks(f: RoundFields | null) {
  if (!f) return;
  const status = $("status");
  const button = $<HTMLButtonElement>("btn-run");
  const network = networkOfKey(f.key);
  button.disabled = true;
  const started = Date.now();
  try {
    await initReader();
    const heights: number[] = [];
    for (let h = f.from; h <= f.to; h++) heights.push(h);
    const replies = new Map<number, BlockReply>();
    let next = 0;
    let failure: Error | null = null;
    status.textContent = `Asking two block servers for ${heights.length} blocks (0 done)...`;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, heights.length) }, async () => {
        while (!failure && next < heights.length) {
          const h = heights[next++];
          try {
            replies.set(h, await getBlock(network, h));
            status.textContent = `Asking two block servers for ${heights.length} blocks (${replies.size} done)...`;
          } catch (e) {
            failure ??= e as Error;
          }
        }
      }),
    );
    if (failure) throw failure;
    const ordered = heights.map((h) => replies.get(h)!);
    const disagree = ordered.filter((x) => !x.agree);
    if (disagree.length) {
      throw new FetchProblem(`The two block servers disagree about block ${disagree[0].height}, so nothing was checked. Do not trust either until they match.`);
    }
    const blocks: ChainBlock[] = ordered.map((x) => ({ height: x.height, txs: x.txs }));
    const contacted = [...new Set(ordered.flatMap((x) => x.serversContacted))];
    let bytes = 0;
    for (const b of blocks) for (const t of b.txs) bytes += (t.txHex.length / 2) * 2;
    status.textContent = "Reading every block with the lot key...";
    await new Promise((r) => setTimeout(r, 20));
    const outcome = refereeRound({
      ...f,
      blocks,
      missing: [],
      source: {
        kind: "light-servers",
        label: "a light server and an explorer, two independent operators agreeing on every block and every transaction",
        serversContacted: contacted,
        bytes,
        ms: Date.now() - started,
      },
    });
    if (!outcome.ok) showError(outcome.kind, outcome.message);
    else render(outcome, ordered, Date.now() - started);
    status.textContent = "";
  } catch (e) {
    status.textContent = "";
    showError("error", e instanceof FetchProblem ? e.message : "Unexpected error while checking. Nothing was kept.");
  } finally {
    button.disabled = false;
  }
}

/** The offline path: blocks from a saved file, read in this tab. No request at all. */
async function checkFile(text: string, name: string) {
  hideAsk();
  const f = readFields();
  if (!f) return;
  const status = $("status");
  status.textContent = "Reading every block in the file with the lot key...";
  const started = Date.now();
  try {
    await initReader();
    await new Promise((r) => setTimeout(r, 20));
    const outcome = checkSavedRound(f, text, name);
    if (!outcome.ok) showError(outcome.kind, outcome.message);
    else render(outcome, null, Date.now() - started, name);
  } catch {
    showError("error", "Unexpected error while checking the file. Nothing was kept.");
  } finally {
    status.textContent = "";
  }
}

function fillExample() {
  $<HTMLTextAreaElement>("f-key").value = EXAMPLE.key;
  $<HTMLInputElement>("f-from").value = EXAMPLE.from;
  $<HTMLInputElement>("f-to").value = EXAMPLE.to;
  $<HTMLInputElement>("f-items").value = EXAMPLE.items;
  $<HTMLInputElement>("f-reserve").value = EXAMPLE.reserve;
  $<HTMLInputElement>("f-close").value = EXAMPLE.close;
  $<HTMLInputElement>("f-lot").value = EXAMPLE.lot;
}

fillExample();
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  ask();
});
$("btn-example").addEventListener("click", () => {
  fillExample();
  ask();
});
$("btn-consent").addEventListener("click", () => {
  void fetchBlocks(pending);
  hideAsk();
});
$("btn-cancel").addEventListener("click", hideAsk);
$("btn-saved").addEventListener("click", () => {
  fillExample();
  void checkFile(savedRoundText, "examples/testnet-01/chain.json");
});
$<HTMLInputElement>("f-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) return showError("error", "Input error: that file is over 50 MB, which is more than one round's blocks should need.");
  await checkFile(await file.text(), file.name);
});
