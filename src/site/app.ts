// Screen code for the checker page. All the checking is in engine.ts (the same checks as the
// command line tool). Nothing here talks to a network, and nothing is stored in the browser.
import { examples, externals, blobs, type ExampleEntry } from "imani-examples";
import { decoderBytes, decoderInfo, fileKind, initReader, parseJsonText, runExternalPage, runPage, scanSourceLine, sealedLine, serversLine, type PageOutcome, type Verdict } from "./engine.ts";
import { sha256Hex } from "./crypto-shim.ts";
import type { Check } from "../check.ts";
import { lookupBid } from "../mine.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

type Selection = { kind: "example"; id: string } | { kind: "own" };

let selection: Selection = { kind: "example", id: "testnet-01" };
let ready = false;
const own: { disclosure?: unknown; result?: unknown; chain?: unknown; chainName?: string; bidderKeys?: unknown; names: string[] } = { names: [] };

const byGroup = (g: ExampleEntry["group"]) => examples.filter((e) => e.group === g);
const find = (id: string) => examples.find((e) => e.id === id)!;

let last: { verdict: Verdict; result: unknown } | null = null;

function outcomeFor(sel: Selection, discreet: boolean): { outcome: PageOutcome; entry?: ExampleEntry; result: unknown } {
  if (sel.kind === "example") {
    const entry = find(sel.id);
    const result = parseJsonText(blobs[entry.result], "result");
    const outcome = runPage({
      disclosure: parseJsonText(blobs[entry.disclosure], "disclosure"),
      result,
      chain: entry.chain ? parseJsonText(blobs[entry.chain], "chain") : undefined,
      chainLabel: "chain.json",
      discreet,
    });
    return { outcome, entry, result };
  }
  return {
    outcome: runPage({ disclosure: own.disclosure, result: own.result, chain: own.chain, chainLabel: own.chainName, bidderKeys: own.bidderKeys, discreet }),
    result: own.result,
  };
}

function list(title: string, items: string[], cls: string): HTMLElement {
  const col = el("div", `col ${cls}`);
  col.appendChild(el("h4", undefined, title));
  if (!items.length) {
    col.appendChild(el("span", "none", "nothing here"));
  } else {
    const ul = el("ul");
    for (const i of items) ul.appendChild(el("li", undefined, i));
    col.appendChild(ul);
  }
  return col;
}

function checkCard(c: Check): HTMLElement {
  const d = el("details", `check ${c.status.toLowerCase()}`);
  d.id = `check-${c.id}`;
  if (c.status === "FAIL") d.open = true;
  const s = el("summary");
  s.appendChild(el("span", "badge", c.status));
  s.appendChild(el("span", "title", c.title));
  s.appendChild(el("span", "reason", c.reason));
  d.appendChild(s);
  const body = el("div", "body");
  const cols = el("div", "cols");
  cols.appendChild(list("From the chain", c.fromChain, "chain"));
  cols.appendChild(list("From the seller's file", c.fromSeller, "seller"));
  cols.appendChild(list("From the disclosure", c.fromDisclosure, "disc"));
  body.appendChild(cols);
  body.appendChild(el("div", "id", `check id: ${c.id}`));
  d.appendChild(body);
  return d;
}

const LEVELS: { level: 1 | 2 | 3; name: string; note: (v: Verdict) => string; status: (v: Verdict) => string }[] = [
  { level: 1, name: "Basic level (no key needed)", note: () => "Looks at the seller's two files only.", status: (v) => v.basicLevel },
  { level: 2, name: "Key level (reads the lot's payments with the lot key)", note: (v) => v.keyLevelNote, status: (v) => v.keyLevel },
  { level: 3, name: "Scan level (reads every block of the auction)", note: (v) => `${scanSourceLine(v)} ${v.scanNotes.join(" ")}`, status: (v) => v.scanLevel },
];

function renderVerdict(v: Verdict, entry?: ExampleEntry): HTMLElement {
  const root = el("div");
  const pass = v.result === "PASS";
  const b = el("div", `banner ${pass ? "pass" : "fail"}`);
  b.setAttribute("role", "status");
  b.appendChild(
    el("div", "big", pass ? `PASS: ${v.checks.length} of ${v.checks.length} checks passed${v.keyLevel === "not run" ? " (basic level only)" : ""}` : `FAIL: ${v.failed.length} of ${v.checks.length} checks failed`),
  );
  if (pass) {
    b.appendChild(el("p", undefined, "The seller's files match what the payments show. Every number below can be traced to its source."));
  } else {
    const ul = el("ul");
    for (const id of v.failed) {
      const c = v.checks.find((x) => x.id === id)!;
      const li = el("li");
      const a = el("a", undefined, `${c.title} (${c.id})`);
      a.href = `#check-${c.id}`;
      li.appendChild(a);
      li.appendChild(document.createTextNode(`: ${c.reason}`));
      ul.appendChild(li);
    }
    b.appendChild(ul);
  }
  if (entry && entry.expectedFailingChecks) {
    const want = [...entry.expectedFailingChecks].sort().join(", ");
    const same = [...v.failed].sort().join(", ") === want;
    b.appendChild(el("p", undefined, same ? `These are the checks this cheat was expected to trip: ${want}.` : `Expected to fail on: ${want}.`));
  } else if (entry && entry.expectedFailingCheck) {
    const same = v.failed.length === 1 && v.failed[0] === entry.expectedFailingCheck;
    b.appendChild(el("p", undefined, same ? `This is the check this copy was built to fail: ${entry.expectedFailingCheck}.` : `Expected to fail on ${entry.expectedFailingCheck}.`));
  }
  root.appendChild(b);

  const servers = el("p", "meta");
  servers.appendChild(el("strong", undefined, "Servers contacted: "));
  servers.appendChild(document.createTextNode(serversLine(v)));
  root.appendChild(servers);
  const key = el("p", "meta");
  key.appendChild(el("strong", undefined, "Lot key: "));
  key.appendChild(
    document.createTextNode(
      v.keyFingerprint ? `accepted as read-only (fingerprint ${v.keyFingerprint}). Not shown, not saved.` : "not used.",
    ),
  );
  root.appendChild(key);
  if (v.discreet) root.appendChild(el("p", "meta", "Discreet mode is on: amounts and memos are hidden."));
  if (v.sealed) root.appendChild(el("p", "meta", sealedLine(v)));

  for (const L of LEVELS) {
    const cs = v.checks.filter((c) => c.level === L.level);
    if (L.level === 3 && !v.scanSource) continue;
    const sec = el("div", "level");
    sec.appendChild(el("h3", undefined, `${L.name}: ${L.status(v)}`));
    const note = L.note(v).trim();
    if (note && (L.level === 3 || !cs.length)) sec.appendChild(el("p", "note", note));
    for (const c of cs) sec.appendChild(checkCard(c));
    root.appendChild(sec);
  }
  return root;
}

function renderExternal(parsed: unknown, name: string): void {
  const out = $("external-out");
  out.replaceChildren();
  const o = runExternalPage(parsed);
  if (!o.ok) {
    out.appendChild(renderProblem({ ok: false, kind: "input", message: `${name}: ${o.message}` }));
    return;
  }
  const rep = o.report;
  const pass = rep.result === "PASS";
  const failed = rep.lines.filter((l) => l.status === "FAIL");
  const b = el("div", `banner ${pass ? "pass" : "fail"}`);
  b.setAttribute("role", "status");
  b.appendChild(el("div", "big", pass ? `PASS: ${rep.lines.length} of ${rep.lines.length} checks passed` : `FAIL: ${failed.length} of ${rep.lines.length} checks failed`));
  b.appendChild(el("p", undefined, `${name}: ${rep.kind} file for lot ${rep.lot}.`));
  out.appendChild(b);
  out.appendChild(el("p", "meta", "Servers contacted: none."));
  for (const l of rep.lines) {
    const d = el("details", `check ${l.status.toLowerCase()}`);
    if (l.status === "FAIL") d.open = true;
    const s = el("summary");
    s.appendChild(el("span", "badge", l.status));
    s.appendChild(el("span", "title", l.title));
    s.appendChild(el("span", "reason", l.detail));
    d.appendChild(s);
    out.appendChild(d);
  }
  for (const n of rep.notes) out.appendChild(el("p", "note", n));
  const lim = el("div", "limits");
  for (const t of rep.limits) lim.appendChild(el("p", "small", t));
  out.appendChild(lim);
  out.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderProblem(o: Extract<PageOutcome, { ok: false }>): HTMLElement {
  const b = el("div", `banner ${o.kind === "refused" ? "refused" : "error"}`);
  b.setAttribute("role", "alert");
  b.appendChild(el("div", "big", o.kind === "refused" ? "Refused" : "Cannot check these files"));
  b.appendChild(el("p", undefined, o.message));
  b.appendChild(el("p", "meta", "Servers contacted: none. Nothing was kept."));
  return b;
}

function render(): void {
  const discreet = $<HTMLInputElement>("discreet").checked;
  const out = $("outcome");
  out.replaceChildren();
  last = null;
  $("mine-out").replaceChildren();
  if (selection.kind === "own" && (own.disclosure === undefined || own.result === undefined)) {
    $("story").textContent = "";
    out.appendChild(el("p", "muted", "Add both the disclosure file and the result file to see a result."));
    return;
  }
  let res;
  try {
    res = outcomeFor(selection, discreet);
  } catch {
    out.appendChild(renderProblem({ ok: false, kind: "error", message: "Unexpected error while checking. Nothing was kept." }));
    return;
  }
  const story = $("story");
  story.textContent = res.entry ? `${res.entry.title}. ${res.entry.story}` : "Your own files.";
  if (res.outcome.ok) last = { verdict: res.outcome.verdict, result: res.result };
  out.appendChild(res.outcome.ok ? renderVerdict(res.outcome.verdict, res.entry) : renderProblem(res.outcome));
  syncChips();
}

/** Links to the real round's payments on a public explorer. Nothing is fetched unless the reader clicks one. */
function renderExplorer(): void {
  const real = examples.find((e) => e.explorer);
  if (!real?.explorer) return;
  const box = $("explorer-box");
  const d = el("details", "explorer");
  d.appendChild(el("summary", undefined, `Look up the ${real.explorer.length} real payments on a public explorer`));
  d.appendChild(el("p", "muted small", "Each link opens another website, which will see your visit. The explorer shows that each payment exists and its block. The amounts and memos are private and only show up with the lot key, as in the check above."));
  const ul = el("ul");
  for (const x of real.explorer) {
    const li = el("li");
    const a = el("a", undefined, x.label);
    a.href = x.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    li.appendChild(a);
    ul.appendChild(li);
  }
  d.appendChild(ul);
  box.appendChild(d);
}

function chip(e: ExampleEntry): HTMLButtonElement {
  const b = el("button", "chip", e.title);
  b.type = "button";
  b.dataset.id = e.id;
  b.addEventListener("click", () => choose(e.id));
  return b;
}

function syncChips(): void {
  const current = selection.kind === "example" ? selection.id : null;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".chip")) {
    b.setAttribute("aria-pressed", String(current !== null && b.dataset.id === current));
  }
  const tampered = byGroup("tampered");
  $("tamper-count").textContent =
    current !== null && tampered.some((e) => e.id === current)
      ? `Showing tampered copy ${tampered.findIndex((e) => e.id === current) + 1} of ${tampered.length}.`
      : `Try a tampered copy: pick the honest round or any of the ${tampered.length} tampered copies.`;
}

/** Show "Checking..." and let the screen paint it before the check starts, because a check of the
 * real round takes a few seconds and would otherwise look like a frozen page. */
function showChecking(): Promise<void> {
  const out = $("outcome");
  out.replaceChildren();
  const p = el("p", "checking", "Checking... this takes a few seconds for the real round.");
  p.setAttribute("role", "status");
  out.appendChild(p);
  out.setAttribute("aria-busy", "true");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".chip")) b.disabled = true;
  // A background tab never fires animation frames, so a plain timer is the fallback.
  return new Promise((done) => {
    requestAnimationFrame(() => setTimeout(done, 30));
    setTimeout(done, 120);
  });
}

function doneChecking(): void {
  $("outcome").removeAttribute("aria-busy");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".chip")) b.disabled = false;
}

async function checkWithNotice(): Promise<void> {
  if (!ready || (selection.kind === "own" && (own.disclosure === undefined || own.result === undefined))) { render(); return; }
  await showChecking();
  try { render(); } finally { doneChecking(); }
}

async function choose(id: string, scroll = true): Promise<void> {
  selection = { kind: "example", id };
  syncChips();
  if (scroll) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  await checkWithNotice();
}

function findMine(): void {
  const out = $("mine-out");
  out.replaceChildren();
  if (!last) {
    out.appendChild(el("p", "notice bad", "Pick an example or add your files above to run a check, then look up your bid."));
    return;
  }
  try {
    const text = lookupBid(last.result, last.verdict, $<HTMLInputElement>("mine-id").value);
    for (const line of text.split("\n")) out.appendChild(el("p", undefined, line));
  } catch (e) {
    out.appendChild(el("p", "notice bad", e instanceof Error ? e.message : "Could not look that up."));
  }
}

async function takeFiles(files: FileList | File[]): Promise<void> {
  const status = $("own-status");
  const problems: string[] = [];
  for (const f of Array.from(files)) {
    try {
      const parsed = parseJsonText(await f.text(), f.name);
      const kind = fileKind(parsed);
      if (!kind) {
        problems.push(`${f.name}: not a file this page knows (no known "format" field).`);
        continue;
      }
      if (kind === "external") {
        renderExternal(parsed, f.name);
        problems.push(`${f.name}: read as a published round (see the section above).`);
        continue;
      }
      if (kind === "chain") { own.chain = parsed; own.chainName = f.name; } else own[kind] = parsed;
      own.names.push(`${kind}: ${f.name}`);
    } catch (e) {
      problems.push(`${f.name}: ${e instanceof Error ? e.message : "could not be read."}`);
    }
  }
  if (own.disclosure !== undefined && own.result === undefined) problems.push("Now add the seller's result file, so the checker has something to compare with.");
  if (own.result !== undefined && own.disclosure === undefined) problems.push("Now add the seller's disclosure file.");
  const have = [own.disclosure !== undefined && "disclosure", own.result !== undefined && "result", own.chain !== undefined && "chain (scan)", own.bidderKeys !== undefined && "bidder keys"].filter(Boolean);
  status.textContent = `Loaded: ${have.length ? have.join(", ") : "nothing yet"}.${problems.length ? " " + problems.join(" ") : ""}`;
  if (own.disclosure === undefined && own.result === undefined && own.chain === undefined && own.bidderKeys === undefined) return;
  selection = { kind: "own" };
  syncChips();
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  await checkWithNotice();
}

async function start(): Promise<void> {
  for (const e of [...byGroup("real-honest"), ...byGroup("real-tampered")]) $("chips-real").appendChild(chip(e));
  renderExplorer();
  for (const x of externals) {
    const b = el("button", "chip", x.title);
    b.type = "button";
    b.addEventListener("click", () => renderExternal(parseJsonText(blobs[x.blob], x.title), x.title));
    $("chips-external").appendChild(b);
  }
  for (const e of [...byGroup("honest"), ...byGroup("tampered")]) $("chips-tampered").appendChild(chip(e));
  for (const e of [...byGroup("scan-honest"), ...byGroup("scan-tampered")]) $("chips-scan").appendChild(chip(e));
  for (const e of [...byGroup("receivers-honest"), ...byGroup("receivers-tampered")]) $("chips-receivers").appendChild(chip(e));
  for (const e of [...byGroup("memo-honest"), ...byGroup("memo-tampered")]) $("chips-memo").appendChild(chip(e));
  for (const e of [...byGroup("goal-honest"), ...byGroup("goal-tampered")]) $("chips-goal").appendChild(chip(e));
  for (const e of [...byGroup("pricing-honest"), ...byGroup("pricing-tampered")]) $("chips-pricing").appendChild(chip(e));
  $("mine-go").addEventListener("click", findMine);
  $("mine-id").addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") findMine(); });
  $("discreet").addEventListener("change", () => void checkWithNotice());

  const drop = $("drop");
  const input = $<HTMLInputElement>("files");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => { if (input.files) void takeFiles(input.files); input.value = ""; });
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("over");
    if (ev.dataTransfer?.files.length) void takeFiles(ev.dataTransfer.files);
  });
  // A file dropped outside the box must not make the browser open it (and leave the page).
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());

  try {
    await initReader();
  } catch {
    $("outcome").replaceChildren(renderProblem({ ok: false, kind: "error", message: "The reader could not start in this browser, so no check was run." }));
    return;
  }
  try {
    const info = decoderInfo();
    $("reader-line").textContent = `Reader: ${info.decoder}, built on librustzcash, reads transactions up to network upgrade ${info.highestUpgrade}. Decoder file imani_decoder_bg.wasm, SHA-256 ${sha256Hex(decoderBytes())} (the same file as in the project's vendor folder).`;
  } catch {
    /* the line is optional */
  }
  ready = true;
  // A link from the checked rounds list: #round=<example id> or #external=<published round id>.
  const m = /^#(round|external)=(.+)$/.exec(location.hash);
  if (m) {
    const id = decodeURIComponent(m[2]);
    if (m[1] === "round" && examples.some((e) => e.id === id)) {
      await choose(id);
      return;
    }
    const x = m[1] === "external" ? externals.find((e) => e.id === id) : undefined;
    if (x) renderExternal(parseJsonText(blobs[x.blob], x.title), x.title);
  }
  await checkWithNotice();
}

void start();
