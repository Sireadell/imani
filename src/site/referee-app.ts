// Screen code for the "check any round" page (check.html). The checking is in referee.ts and the
// checker it calls, the same code as the command line tool. This page makes network calls only
// after the reader presses the ask button, and only these: GET /api/block?network=...&height=...
// to the site it was loaded from. The saved-file path makes none. The lot key is never put in a
// request. It is read from the box, used in this tab, and not stored.
import { initReader } from "./engine.ts";
import { refereeRound, networkOfKey, type RefereeOutcome, type RefereeRound } from "./referee.ts";
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

/** What the last check was run on, so the result buttons can say it again or write it down. */
let current: RoundFields | null = null;
let lastFile: { text: string; name: string } | null = null;

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

function row(table: HTMLTableElement, cells: string[], head = false, cls = "") {
  const tr = el("tr", cls || undefined);
  for (const c of cells) tr.appendChild(el(head ? "th" : "td", undefined, c));
  table.appendChild(tr);
}

const zatShort = (n: number) => `${n.toLocaleString("en-US")} zat`;

/** The lines of the certificate card, all from the recomputed round. */
function certificateRows(r: RefereeRound): [string, string][] {
  const rows: [string, string][] = [
    ["Bids counted", String(r.bidCount)],
    ["Winners", String(r.winners.length)],
    ["Clearing price", r.reserveMet ? zatShort(r.clearingPriceZat) : "none"],
  ];
  if (r.refunds.length) rows.push(["Refunds paid in full", `${r.refunds.filter((f) => f.owedZat === f.paidZat).length} of ${r.refunds.length}`]);
  return rows;
}

function downloadCertificate(lot: string, pass: boolean, passed: number, total: number, network: string, rows: [string, string][], checks: Check[]) {
  const lines = [
    `Fairness certificate${pass ? "" : " (not issued)"}`,
    `Lot: ${lot}`,
    ...(network ? [`Network: ${network}`] : []),
    ...(current ? [`Blocks: ${current.from} to ${current.to}`] : []),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    `Verdict: ${pass ? "FAIR" : "NOT FAIR"}`,
    `Checks passed: ${passed} of ${total}`,
    "",
    ...checks.map((c) => `${c.status}  ${c.title}`),
    "",
    "Anyone can run the same check and should get the same answer.",
    "",
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
  const a = el("a");
  a.href = url;
  a.download = `imani-certificate-${lot.replace(/[^A-Za-z0-9_-]+/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function render(o: Extract<RefereeOutcome, { ok: true }>, replies: BlockReply[] | null, ms: number, fileName = "") {
  const out = $("result");
  out.replaceChildren();
  const v = o.verdict;
  const r = o.round;
  const pass = v.result === "PASS";
  const passed = v.checks.filter((c) => c.status === "PASS").length;
  const total = v.checks.length;
  const rows = certificateRows(r);
  out.appendChild(el("h3", "result-title", `Result for lot ${r.lotId}`));
  const card = el("div", `banner doc ${pass ? "pass" : "fail"}`);
  const network = current ? (networkOfKey(current.key) === "main" ? "Zcash mainnet" : "Zcash test network") : "";
  card.appendChild(el("div", "k", pass ? `Fairness certificate${network ? ` · ${network}` : ""}` : "Fairness certificate · not issued"));
  if (current) card.appendChild(el("p", "sub", `Blocks ${current.from.toLocaleString("en-US")} to ${current.to.toLocaleString("en-US")} · ${(current.to - current.from + 1).toLocaleString("en-US")} blocks`));
  card.appendChild(
    el(
      "p",
      "sub",
      pass
        ? `Every block was read with the lot key, and the refunds the lot paid match what the rules owe, to the zatoshi.`
        : `Failed: ${v.failed.join(", ")}.`,
    ),
  );
  for (const [k, val] of rows) {
    const ln = el("div", "ln");
    ln.appendChild(el("span", undefined, k));
    ln.appendChild(el("span", "d"));
    ln.appendChild(el("span", undefined, val));
    card.appendChild(ln);
  }
  const stamp = el("div", "stamp");
  const verdict = el("div");
  verdict.appendChild(el("div", "k", "Verdict"));
  verdict.appendChild(el("div", "big", pass ? "FAIR" : "NOT FAIR"));
  stamp.appendChild(verdict);
  const count = el("div", "count");
  count.appendChild(el("div", "n", `${passed} of ${total}`));
  count.appendChild(el("div", "small", "checks passed"));
  stamp.appendChild(count);
  card.appendChild(stamp);
  out.appendChild(card);

  const acts = el("div", "acts");
  const dl = el("button", "btn primary", "Download summary (text)");
  dl.type = "button";
  dl.addEventListener("click", () => downloadCertificate(r.lotId, pass, passed, total, network, rows, v.checks));
  const again = el("button", "btn", "Run it again");
  again.type = "button";
  again.addEventListener("click", () => (lastFile ? void checkFile(lastFile.text, lastFile.name) : ask()));
  acts.append(dl, again);
  out.appendChild(acts);

  out.appendChild(el("h3", undefined, "What the chain says, recomputed"));
  const t = el("table", "grid");
  row(t, ["", "Recomputed from the blocks"], true);
  row(t, ["Bids counted", `${r.bidCount}${r.lateBids ? ` (and ${r.lateBids} late or repeated, owed back in full)` : ""}`]);
  row(t, ["Reserve met", r.reserveMet ? "yes" : "no, so there are no winners"]);
  row(t, ["Clearing price", r.reserveMet ? `${zat(r.clearingPriceZat)} for each item` : "none"]);
  for (const w of r.winners) row(t, [`Winner`, `bid ${short(w.txid)} of ${zat(w.amountZat)}: pays ${zat(w.paysZat)}, gets back ${zat(w.refundZat)}`], false, "winner");
  for (const l of r.losers) row(t, [`Did not win`, `bid ${short(l.txid)} of ${zat(l.amountZat)}: gets back all of it`], false, "loser");
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

const LEVELS: [Check["level"], string][] = [
  [1, "Basic"],
  [2, "With the lot key"],
  [3, "Full scan"],
];

function checkItem(c: Check): HTMLDetailsElement {
  const ok = c.status === "PASS";
  const d = el("details", `check ${ok ? "pass" : "fail"}`);
  if (!ok) d.open = true;
  const sum = el("summary");
  sum.appendChild(el("span", "visually-hidden", `${c.status} `));
  sum.appendChild(el("b", "mark", ok ? "\u2713" : "\u2715"));
  sum.appendChild(document.createTextNode(`${c.title}${BY_CONSTRUCTION.has(c.id) ? " (matches by construction here)" : ""}`));
  d.appendChild(sum);
  d.appendChild(el("p", undefined, c.reason));
  return d;
}

function renderChecks(out: HTMLElement, o: Extract<RefereeOutcome, { ok: true }>) {
  const pass = o.verdict.result === "PASS";
  out.appendChild(el("h3", undefined, pass ? "The checks, in three levels" : "Where it failed"));
  for (const [level, name] of LEVELS) {
    const group = o.verdict.checks.filter((c) => c.level === level);
    if (!group.length) continue;
    const fails = group.filter((c) => c.status === "FAIL");
    const passes = group.filter((c) => c.status === "PASS");
    const head = el("div", "gr");
    head.appendChild(el("span", undefined, name));
    head.appendChild(el("span", undefined, `${passes.length} of ${group.length}`));
    out.appendChild(head);
    // A failed check always shows, first. On a fair round the first passing check shows as a sample.
    const shown = fails.length ? fails : pass ? passes.slice(0, 1) : [];
    const rest = group.filter((c) => !shown.includes(c));
    const list = el("div");
    for (const c of shown) list.appendChild(checkItem(c));
    out.appendChild(list);
    if (!rest.length) continue;
    const more = el("div");
    more.hidden = true;
    for (const c of rest) more.appendChild(checkItem(c));
    const toggle = el("button", "more", shown.length ? `Show ${rest.length} more` : `Show ${rest.length} checks`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      more.hidden = !more.hidden;
      toggle.setAttribute("aria-expanded", String(!more.hidden));
      toggle.textContent = more.hidden ? (shown.length ? `Show ${rest.length} more` : `Show ${rest.length} checks`) : "Hide";
    });
    out.appendChild(toggle);
    out.appendChild(more);
  }

  out.appendChild(el("h3", undefined, "What this check does not prove"));
  const ul = el("ul");
  ul.appendChild(el("li", undefined, "There is no seller list here to compare with. So 'the seller left out a bid' cannot be tested. A bid is missed only if it never reached this lot's address, which the key would show."));
  ul.appendChild(el("li", undefined, `The rules used are the ones you chose above: the items and reserve you typed, and the price rule ${o.round.pricing === "lowest-winning" ? "where the lowest bid that won sets the price" : "where the highest bid that did not win sets the price, never below the reserve"}. ${o.round.topUps ? "Several payments with the same memo before the close were added up as one bid." : "A second payment with the same memo counted as a replay, not as a higher bid."}`));
  if (o.closeAssumed) ul.appendChild(el("li", undefined, "No close block was given, so every bid in the range counted as on time."));
  ul.appendChild(el("li", undefined, "Who a refund was sent to is not shown by the lot key alone, unless bidders wrote their refund address in the bid memo."));
  out.appendChild(ul);

  if (pass) {
    out.appendChild(el("h3", undefined, "What stayed private"));
    out.appendChild(el("p", "private", "Hidden from anyone without the lot key: every bid amount, who bid, every wallet."));
  }
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
  current = {
    key,
    from,
    to,
    itemCount: num("f-items"),
    reserveZat: num("f-reserve"),
    pricing: $<HTMLSelectElement>("f-pricing").value === "lowest-winning" ? "lowest-winning" : "highest-losing",
    topUps: $<HTMLSelectElement>("f-topups").value === "yes",
    closeHeight: closeText === "" ? undefined : Number(closeText.replace(/[,\s]/g, "")),
    lotId: lotText === "" ? undefined : lotText,
  };
  return current;
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
  lastFile = null;
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
  lastFile = { text, name };
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
  $<HTMLSelectElement>("f-pricing").value = "highest-losing";
  $<HTMLSelectElement>("f-topups").value = "no";
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
