// HTML for the shop auction demo. Plain server-rendered pages: every form works without
// JavaScript except sign-in, which needs the browser to make the account key.
// Nothing here loads from another website: no fonts, no scripts, no images from elsewhere.
import { formatZec } from "../src/login/index.ts";
import type { Verdict } from "../src/check.ts";
import type { BrokenCopy, CheckRun, Lot, SellerBidLine } from "./lot.ts";

export interface PageContext {
  mode: "sim" | "live";
  network: "main" | "test";
  /** Signed-in account id for this site, or null. */
  account: string | null;
  lot: Lot | null;
  /** Servers this shop has contacted since it started (live mode). */
  serversContacted: string[];
  loginMinZat: number;
}

export const esc = (s: unknown) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const zec = (zat: number) => `${formatZec(zat)} ZEC`;
const num = (n: number) => n.toLocaleString("en-US");
export const shortAccount = (id: string) => id.slice(0, 6);

function serversLine(ctx: PageContext): string {
  if (ctx.mode === "sim") return "Servers contacted: none. Simulated mode never uses the network.";
  return `Servers contacted: ${ctx.serversContacted.length ? ctx.serversContacted.map(esc).join(", ") : "none yet"}.`;
}

function banner(ctx: PageContext): string {
  if (ctx.mode === "sim") {
    return `<div class="mode mode-sim" role="status"><strong>SIMULATED</strong><span>Simulated payments and a pretend block clock. No real money moves and nothing is sent to the Zcash network.</span></div>`;
  }
  return `<div class="mode mode-live" role="status"><strong>LIVE</strong><span>Real Zcash payments on the ${ctx.network === "main" ? "main" : "test"} network, read from public Zcash servers.</span></div>`;
}

const NAV = [
  ["/", "Shop"],
  ["/lot", "The lot"],
  ["/seller", "Seller"],
  ["/check", "Check the auction"],
] as const;

export function layout(ctx: PageContext, title: string, active: string, body: string): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${active === href ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const who = ctx.account
    ? `<form method="post" action="/logout" class="who"><span class="chip" title="Your account id on this shop">Account ${esc(shortAccount(ctx.account))}</span><button class="link" type="submit">Sign out</button></form>`
    : `<a class="btn btn-small" href="/signin">Sign in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Imani shop</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:,">
</head>
<body data-mode="${ctx.mode}">
${banner(ctx)}
<header class="top">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">i</span><span>Imani <small>shop auction</small></span></a>
  <nav aria-label="Main">${nav}</nav>
  <div class="account">${who}</div>
</header>
<main>
${body}
</main>
<footer>
  <p>${serversLine(ctx)} No analytics. Nothing on this site loads from anywhere else.</p>
  <p><a href="/privacy">What this site learns</a> · <a href="/privacy#limits">Honest limits</a>${ctx.mode === "sim" ? ` · <form method="post" action="/sim/reset" class="inline"><button class="link" type="submit">Restart the demo</button></form>` : ""}</p>
  <p class="muted">Imani means trust in Swahili.</p>
</footer>
</body>
</html>
`;
}

export function learnsPanel(ctx: PageContext): string {
  return `<section class="card panel" id="learns" aria-labelledby="learns-h">
<h2 id="learns-h">What this site learns and what the servers learn</h2>
<div class="cols">
  <div>
    <h3>This shop learns</h3>
    <ul>
      <li>Your account id for this shop (a public code made from your account key)</li>
      <li>That a sign-in payment of ${zec(ctx.loginMinZat)} arrived, and when</li>
      <li>Your bid amount and memo word, once the bid arrives at the lot address</li>
    </ul>
  </div>
  <div>
    <h3>This shop never learns</h3>
    <ul>
      <li>Your wallet address or balance</li>
      <li>Your account key</li>
      <li>Your account on any other site</li>
    </ul>
  </div>
  <div>
    <h3>The Zcash servers learn</h3>
    <ul>
      ${ctx.mode === "sim"
        ? "<li>Nothing. Simulated mode contacts no server.</li>"
        : "<li>The transaction ids this shop asks about, the shop's internet address and the time. Never a key.</li>"}
    </ul>
  </div>
</div>
<p class="servers">${serversLine(ctx)} Your browser talks only to this shop.</p>
</section>`;
}

export function limitsPanel(): string {
  return `<section class="card panel" id="limits" aria-labelledby="limits-h">
<h2 id="limits-h">Honest limits</h2>
<ul class="limits">
  <li><strong>Signing in proves two things only:</strong> you hold this account key, and you can pay from a private Zcash wallet. It does not prove which wallet, or who you are.</li>
  <li><strong>The seller can see bids as they arrive.</strong> The seller holds the lot key from the start. The check proves the counting, the amounts and the refunds, not that the seller never looked.</li>
  <li><strong>The check works only if the seller shares the lot key</strong> after the close. Once shared it cannot be taken back, so every lot gets its own fresh key.</li>
  <li><strong>Publishing the lot key shows every bid amount and refund</strong> to anyone who reads it.</li>
  <li><strong>This version checks the payments the seller lists</strong> and trusts the block heights in the seller's file.</li>
</ul>
</section>`;
}

function lotFacts(ctx: PageContext, lot: Lot): string {
  const i = lot.info;
  const now = lot.height !== null
    ? `<div><dt>Now</dt><dd>Block ${num(lot.height)}<small>${ctx.mode === "sim" ? "pretend clock" : ""}</small></dd></div>`
    : "";
  return `<dl class="facts">
  <div><dt>Items</dt><dd>${i.itemCount}</dd></div>
  <div><dt>Lowest price accepted</dt><dd>${zec(i.reserveZat)}</dd></div>
  <div><dt>Bids close after</dt><dd>Block ${num(i.closeHeight)}</dd></div>
  ${now}
  <div><dt>Status</dt><dd><span class="status ${lot.closed ? "st-closed" : "st-open"}">${lot.closed ? "Closed" : "Open for bids"}</span></dd></div>
</dl>`;
}

export function homePage(ctx: PageContext): string {
  const lot = ctx.lot;
  const lotCard = lot
    ? `<a class="card lot-card" href="/lot">
  <span class="eyebrow">Lot ${esc(lot.info.lotId)}</span>
  <h2>${esc(lot.info.title)}</h2>
  <p>${esc(lot.info.description)}</p>
  ${lotFacts(ctx, lot)}
  <span class="btn">${lot.closed ? "See the result" : "See the lot and bid"}</span>
</a>`
    : `<div class="card"><h2>No lot yet</h2><p>Live mode has no lot set up. Put a lot.json in the folder named by IMANI_LOT_DIR.</p></div>`;
  return layout(ctx, "Shop", "/", `
<section class="hero">
  <div>
    <h1>A sealed-bid auction you can check yourself.</h1>
    <p class="lead">Sign in with a private Zcash wallet, bid without anyone else seeing your bid, and after the close check from the payments themselves that the seller counted every bid and paid every refund.</p>
    <ol class="steps">
      <li><a href="/signin"><span><strong>Sign in</strong> with a private Zcash wallet</span></a></li>
      <li><a href="/lot"><span><strong>Bid</strong> with a private payment</span></a></li>
      <li><a href="/seller"><span><strong>Seller publishes</strong> the result and a one-time lot key</span></a></li>
      <li><a href="/check"><span><strong>Anyone checks</strong> the auction: pass or fail</span></a></li>
    </ol>
  </div>
  ${lotCard}
</section>
${learnsPanel(ctx)}
${limitsPanel()}`);
}

export function privacyPage(ctx: PageContext): string {
  return layout(ctx, "What this site learns", "/privacy", `<h1>What this site learns</h1>${learnsPanel(ctx)}${limitsPanel()}
<section class="card panel"><h2>Where your keys stay</h2><ul>
<li>Your account key is made in your browser and stays in this tab's memory. It is never sent, never put in a web address and never saved in browser storage. Save the backup file if you want to use the same account again.</li>
<li>The lot key is a throwaway key for this one lot. The shop keeps it on its own computer until the seller publishes it, and it only ever leaves inside the published disclosure file. It is never in a web address, a page, a cookie or a log line.</li>
</ul></section>`);
}

export function signinPage(ctx: PageContext, challengeInfo: { siteId: string; network: string; minZat: number }): string {
  const signedIn = ctx.account
    ? `<p class="notice ok">You are signed in as account <strong>${esc(shortAccount(ctx.account))}</strong>. You can sign in again below, for example from a new wallet address.</p>`
    : "";
  const step3 = ctx.mode === "sim"
    ? `<div class="wallet" id="sim-wallet" hidden>
  <p class="wallet-title">Pretend wallet <small>on your side, simulated</small></p>
  <p>Your wallet would open the link above and show you this payment:</p>
  <dl class="pay"><div><dt>Pay</dt><dd id="w-amount"></dd></div><div><dt>To</dt><dd><code id="w-to"></code></dd></div><div><dt>Note (memo)</dt><dd>Sign-in message for <strong>${esc(challengeInfo.siteId)}</strong>, code <code id="w-code"></code></dd></div></dl>
  <div class="row">
    <button class="btn" type="button" id="pay-1">Pay from wallet address 1</button>
    <button class="btn btn-quiet" type="button" id="pay-2">Pay from a new wallet address</button>
  </div>
  <p class="muted">Wallets hand out new addresses all the time. Your wallet address is never sent to the shop, so either button signs in to the same account.</p>
</div>`
    : `<div class="wallet" id="live-wallet" hidden>
  <p>After your wallet sends the payment, paste the transaction id it shows you.</p>
  <label for="txid">Transaction id</label>
  <input id="txid" inputmode="latin" autocomplete="off" spellcheck="false" placeholder="64 letters and digits">
  <button class="btn" type="button" id="check-pay">Check my payment</button>
</div>`;
  return layout(ctx, "Sign in", "/signin", `
<h1>Sign in with a private Zcash wallet</h1>
<p class="lead">No email and no password. Your wallet sends a tiny private payment (${zec(challengeInfo.minZat)}) carrying a signed note. The shop reads the note and signs you in. It never learns your wallet address or your balance.</p>
${signedIn}
<noscript><p class="notice">Signing in needs JavaScript, because your account key is made on your device and is never sent to the shop. The rest of this site works without it.</p></noscript>
<div id="signin" data-mode="${ctx.mode}" data-site="${esc(challengeInfo.siteId)}" hidden>
  <p class="notice bad" id="no-crypto" hidden>This browser cannot make the account key. It needs Ed25519 in Web Crypto (Chrome 137 or newer, Firefox 129 or newer, Safari 17 or newer). Please update the browser. Nothing was sent.</p>
  <section class="card step" id="step-key">
    <h2><span class="n">1</span> Your account key</h2>
    <p>Your account key is made here, in this browser tab. The shop never sees it. Your account stays the same even when your wallet uses a new address.</p>
    <div class="row">
      <button class="btn" type="button" id="make-key">Make my account key</button>
      <button class="btn btn-quiet" type="button" id="show-import">Use a saved backup</button>
    </div>
    <div id="import-box" hidden>
      <label for="import-text">Paste your backup line (starts with imani-login-key-1:)</label>
      <textarea id="import-text" rows="2" autocomplete="off" spellcheck="false"></textarea>
      <button class="btn" type="button" id="do-import">Load backup</button>
    </div>
    <div id="key-ready" hidden>
      <p class="notice ok">Account key ready. It lives only in this tab.</p>
      <button class="btn btn-quiet" type="button" id="save-backup">Save backup file</button>
      <p class="muted" id="backup-warning"></p>
    </div>
  </section>
  <section class="card step" id="step-code" hidden>
    <h2><span class="n">2</span> Get a one-time sign-in code</h2>
    <button class="btn" type="button" id="get-code">Get a sign-in code</button>
    <div id="code-box" hidden>
      <p class="code" id="code" aria-label="Sign-in code"></p>
      <p class="muted">Works once, for this shop only, for 10 minutes.</p>
      <p>Open this payment link in your Zcash wallet (wallets such as Zodl fill in the amount and the signed note for you):</p>
      <p><a class="btn" id="open-wallet" href="#">Open in my wallet</a> <button class="btn btn-quiet" type="button" id="copy-link">Copy link</button></p>
      <textarea id="pay-link" rows="3" readonly aria-label="Payment link"></textarea>
      <p class="muted">The link pays exactly one address: this shop's sign-in address. Do not show it to anyone else until you have paid.</p>
    </div>
  </section>
  <section class="card step" id="step-pay" hidden>
    <h2><span class="n">3</span> Pay from your wallet</h2>
    ${step3}
  </section>
  <section class="card step result" id="step-done" hidden>
    <h2>Signed in</h2>
    <p class="learned">This shop knows you as <strong>account <span id="acct-short"></span></strong>, and that you paid ${zec(challengeInfo.minZat)}. The receipt below lists every item it stored to keep you signed in.</p>
    <dl class="pay"><div><dt>Account id</dt><dd><code id="acct-full"></code></dd></div><div><dt>Not learned</dt><dd>Your wallet address, your balance, your account key</dd></div></dl>
    <p class="notice ok" id="same-account" hidden></p>
    <section class="receipt" id="receipt" aria-labelledby="receipt-h" hidden>
      <h3 id="receipt-h">Receipt: what this shop stored</h3>
      <p class="muted">Read from the shop's real storage just now, not typed by hand.</p>
      <table class="receipt-table"><thead><tr><th>Where</th><th>What</th><th>Value</th></tr></thead><tbody id="receipt-rows"></tbody></table>
      <p id="receipt-shared" class="muted"></p>
      <h4>Searched for things the shop must not hold</h4>
      <ul id="receipt-probes" class="probes"></ul>
      <p class="muted">The last two lines are checked in this tab. Your account key and your login memo never leave it.</p>
    </section>
    <div class="row">
      <a class="btn" href="/lot">Go to the lot</a>
      <button class="btn btn-quiet" type="button" id="again">Sign in again from a new wallet address</button>
    </div>
  </section>
  <p class="notice bad" id="err" role="alert" hidden></p>
</div>
<script type="module" src="/static/signin.js"></script>`);
}

export function lotPage(ctx: PageContext): string {
  const lot = ctx.lot;
  if (!lot) return layout(ctx, "The lot", "/lot", `<h1>No lot yet</h1><p>Live mode has no lot set up. Put a lot.json in the folder named by IMANI_LOT_DIR.</p>`);
  const i = lot.info;
  const sim = lot.sim;
  let bidBox: string;
  if (lot.closed) {
    bidBox = `<p class="notice">Bidding has closed. ${lot.published ? `The seller has published the result. <a href="/check">Check this auction</a>.` : "The seller will publish the result and the lot key next."}</p>`;
  } else if (!ctx.account) {
    bidBox = `<p>Sign in first, so the shop can show you your own bid later.</p><a class="btn" href="/signin">Sign in to bid</a>`;
  } else {
    bidBox = `<div id="bid" data-mode="${ctx.mode}" data-lot="${esc(i.lotId)}" data-address="${esc(i.address)}"${sim ? ` data-amount="${formatZec(sim.yourBid.amountZat)}" data-word="${esc(sim.yourBid.memo.split(":")[2])}" data-refund="${esc(sim.yourBid.memo.split(":")[3] ?? "")}"` : ""}>
  ${sim ? `<p class="muted">Simulated mode replays bid 2 of a recorded test round, so the amount and memo word are fixed. That way the published files and the check match your bid exactly.</p>` : ""}
  <div class="grid2">
    <div><label for="bid-amount">Your bid in ZEC</label><input id="bid-amount" name="amount" inputmode="decimal" value="${sim ? formatZec(sim.yourBid.amountZat) : ""}"${sim ? " readonly" : ""} placeholder="for example 0.02"></div>
    <div><label for="bid-word">Memo word</label><input id="bid-word" name="word" value="${sim ? esc(sim.yourBid.memo.split(":")[2]) : ""}"${sim ? " readonly" : ""} autocomplete="off" spellcheck="false"></div>
  </div>
  <div><label for="bid-refund">Your refund address</label><input id="bid-refund" name="refund" value="${sim ? esc(sim.yourBid.memo.split(":")[3] ?? "") : ""}"${sim ? " readonly" : ""} autocomplete="off" spellcheck="false" placeholder="a fresh address from your wallet"><p class="muted small">It goes at the end of your bid memo. Your refund must go to it, and the seller cannot change it. Use a fresh address, because after the close anyone can see where each refund went.</p></div>
  <noscript><p class="notice">Without JavaScript: send your bid from your wallet to the lot address above with the memo <code>bid:${esc(i.lotId)}:</code> then a word you choose, a colon and your refund address.</p></noscript>
  <button class="btn" type="button" id="make-bid" hidden>Make my bid link</button>
  <div id="bid-link-box" hidden>
    <p><a class="btn" id="bid-open" href="#">Open in my wallet</a></p>
    <textarea id="bid-link" rows="3" readonly aria-label="Bid payment link"></textarea>
    ${sim ? `<div class="wallet"><p class="wallet-title">Pretend wallet <small>on your side, simulated</small></p><p>Send <strong id="bw-amount"></strong> to the lot address with the memo <code id="bw-memo"></code>?</p><button class="btn" type="button" id="send-bid">Send bid</button></div>` : `<p class="muted">After your wallet sends it, keep the transaction id it shows you. It is your receipt.</p>`}
  </div>
  <div id="receipt" hidden>
    <p class="notice ok">Bid sent. Your receipt (the transaction id): <code id="receipt-id"></code></p>
    <p class="muted">Keep it. After the close, paste it on the check page to see that your bid was counted and refunded correctly. The shop does not keep a link between your account and your bid.</p>
  </div>
  <p class="notice bad" id="bid-err" role="alert" hidden></p>
</div>
<script type="module" src="/static/lot.js"></script>`;
  }
  const clock = sim && !lot.closed ? clockForm("/lot", "Skip to after the close") : "";
  return layout(ctx, `Lot ${i.lotId}`, "/lot", `
<span class="eyebrow">Lot ${esc(i.lotId)}</span>
<h1>${esc(i.title)}</h1>
<p class="lead">${esc(i.description)}</p>
<section class="card">${lotFacts(ctx, lot)}${clock}</section>
<div class="cols2">
<section class="card">
  <h2>How bidding works</h2>
  <ol>
    <li>Send your bid as a private payment to the lot address, with the memo <code>bid:${esc(i.lotId)}:</code>, a short word you choose, a colon and your own refund address.</li>
    <li>Nobody else can see the bids before the close.</li>
    <li>The ${i.itemCount} highest bids win. Every winner pays the same price: the highest losing bid, but never less than ${zec(i.reserveZat)}.</li>
    <li>Losers get their whole bid back. Winners get back the difference.</li>
  </ol>
  <p class="label">Lot address</p>
  <p><code class="addr">${esc(i.address)}</code></p>
</section>
<section class="card">
  <h2>Place a bid</h2>
  <p class="notice warn"><strong>Before you bid:</strong> after the close the seller publishes the lot key, and then anyone can see every bid amount and the address each refund went to. Get your refund at a fresh address and put nothing personal in the memo.</p>
  ${bidBox}
</section>
</div>`);
}

function clockForm(back: string, label: string): string {
  return `<form method="post" action="/sim/clock" class="clock"><input type="hidden" name="back" value="${esc(back)}"><button class="btn btn-quiet" type="submit">${esc(label)}</button><span class="muted">Pretend clock: jumps to a block after the close and after the seller has paid the refunds.</span></form>`;
}

export function sellerPage(ctx: PageContext, error?: string): string {
  const lot = ctx.lot;
  if (!lot) return layout(ctx, "Seller", "/seller", `<h1>No lot yet</h1><p>Live mode has no lot set up. Put a lot.json in the folder named by IMANI_LOT_DIR.</p>`);
  const sim = !!lot.sim;
  const bids = lot.sellerBids();
  const bidRows = bids.length
    ? `<table class="table"><thead><tr><th>Block</th><th>Amount</th><th>Memo word</th><th>Counts?</th></tr></thead><tbody>${bids
        .map((b: SellerBidLine) => `<tr><td>${num(b.height)}</td><td class="money">${zec(b.amountZat)}</td><td><code>${esc(b.word)}</code>${b.yours ? ' <span class="chip">your bid</span>' : ""}</td><td>${b.late ? '<span class="status st-fail">Late, returned in full</span>' : '<span class="status st-open">On time</span>'}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No bids yet.</p>`;
  const liveView = sim
    ? `<section class="card"><h2>Bids the seller can see right now</h2>
<p class="notice warn">The seller holds the lot key from the start, so the seller can read bids as they arrive. This is a known limit. The check later proves the counting, amounts and refunds, not that the seller never looked.</p>
${bidRows}</section>`
    : `<section class="card"><h2>Bids</h2><p>In live mode the seller reads bids in their own wallet with the lot key. This page does not show live bids.</p></section>`;
  let publishBox: string;
  if (lot.published) {
    publishBox = `<p class="notice ok">Published. Anyone can now check this lot.</p>
<dl class="pay"><div><dt>Lot key fingerprint</dt><dd><code>${esc(lot.published.fingerprint)}</code> <small>the key itself is only inside the disclosure file</small></dd></div></dl>
<ul><li><a href="/lot/files/result.json" download>result.json</a>: who won, the price and every refund</li><li><a href="/lot/files/disclosure.json" download>disclosure.json</a>: the lot's payments and the one-time lot key</li></ul>
<a class="btn" href="/check">Check this auction</a>`;
  } else {
    const ready = lot.canPublish;
    publishBox = `<p>This publishes two files: the result (who won, the price, every refund) and a disclosure file with a one-time key for this lot only. The key can read this lot's payments but can never move money. Once published it cannot be taken back, which is why each lot has its own key.</p>
<form method="post" action="/seller/publish"><button class="btn" type="submit"${ready ? "" : " disabled"}>Publish the result and the lot key</button></form>
${ready ? "" : `<p class="muted">${sim ? "Available after the close, once refunds are paid. Use the pretend clock below." : "Put disclosure.json and result.json in IMANI_LOT_DIR, then reload."}</p>`}`;
  }
  return layout(ctx, "Seller", "/seller", `
<span class="eyebrow">Seller's page</span>
<h1>Run lot ${esc(lot.info.lotId)}</h1>
<p class="lead">In a real shop only the seller sees this page. Here it is open so you can play both sides.</p>
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ""}
<section class="card">${lotFacts(ctx, lot)}${sim && !lot.canPublish && !lot.published ? clockForm("/seller", "Skip to after the close and refunds") : ""}</section>
<div class="cols2">
${liveView}
<section class="card"><h2>Publish the result</h2>${publishBox}</section>
</div>`);
}

export function checkPage(ctx: PageContext, copies: BrokenCopy[]): string {
  const lot = ctx.lot;
  const published = lot?.published;
  const honest = published
    ? `<section class="card">
<h2>The published auction</h2>
<ul><li><a href="/lot/files/result.json" download>result.json</a> from the seller</li><li><a href="/lot/files/disclosure.json" download>disclosure.json</a> with the one-time lot key (fingerprint <code>${esc(published.fingerprint)}</code>)</li></ul>
<form method="post" action="/check"><input type="hidden" name="copy" value="published"><button class="btn btn-big" type="submit">Check this auction</button></form>
</section>`
    : `<section class="card"><h2>Not published yet</h2><p>The seller has not published the result and the lot key yet. ${ctx.mode === "sim" ? `Go to the <a href="/seller">seller's page</a> to do it.` : ""}</p></section>`;
  const options = copies.map((c) => `<option value="${esc(c.name)}"${c.name === "04-short-refund" ? " selected" : ""}>${esc(c.story)}</option>`).join("");
  return layout(ctx, "Check the auction", "/check", `
<h1>Check this auction</h1>
<p class="lead">Anyone can check this lot. The checker reads the lot's payments with the published lot key and works the result out again: the bid count, every amount, the winners, the price and every refund. Then it compares that with what the seller published.</p>
<div class="cols2">
${honest}
<section class="card">
<h2>Try a tampered copy</h2>
<p>Each copy of the recorded round has one number changed. The check should fail and name the reason.</p>
<form method="post" action="/check">
<label for="copy">What the seller got wrong</label>
<select id="copy" name="copy">${options}</select>
<button class="btn btn-quiet" type="submit">Try a tampered copy</button>
</form>
</section>
</div>
<p class="servers">Servers contacted by the check: none. It runs on this shop's computer using only the two files.</p>`);
}

const CHANGE_WORDS: [RegExp, string][] = [
  [/^bids\[(\d+)\]\.amountZat/, "bid $1 amount (zatoshis)"],
  [/^refunds\[(\d+)\]\.amountZat/, "refund $1 amount (zatoshis)"],
  [/^clearingPriceZat/, "price each winner pays (zatoshis)"],
  [/^bidCount/, "number of bids"],
  [/^bids:/, "bid list:"],
  [/^refunds:/, "refund list:"],
];
const plainChange = (c: string) => CHANGE_WORDS.reduce((s, [re, to]) => s.replace(re, to), c);

function verdictBody(v: Verdict): string {
  const rows = v.checks
    .map(
      (c) => `<li class="chk ${c.status === "PASS" ? "chk-pass" : "chk-fail"}">
<span class="status ${c.status === "PASS" ? "st-pass" : "st-fail"}">${c.status}</span>
<div><strong>${esc(c.title)}</strong> <code class="muted">${esc(c.id)}</code><p>${esc(c.reason)}</p>
${c.fromChain.length || c.fromSeller.length ? `<details><summary>Where the numbers come from</summary>${c.fromChain.length ? `<p class="label">From the payments, read with the lot key</p><ul>${c.fromChain.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${c.fromSeller.length ? `<p class="label">From the seller's result file</p><ul>${c.fromSeller.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</details>` : ""}
</div></li>`,
    )
    .join("");
  return `<ol class="checks">${rows}</ol>`;
}

export function resultPage(ctx: PageContext, run: CheckRun): string {
  if (run.error || !run.verdict) {
    return layout(ctx, "Check result", "/check", `<h1>Check this auction</h1><p class="notice bad" role="alert">${esc(run.error ?? "The check could not run.")}</p><p class="servers">Servers contacted: none.</p><a class="btn" href="/check">Back</a>`);
  }
  const v = run.verdict;
  const pass = v.result === "PASS";
  const failed = v.checks.filter((c) => c.status === "FAIL");
  const tamper = run.broken
    ? `<section class="card"><h2>What was changed</h2><p>${esc(run.broken.story)}</p>${run.changes.length ? `<p class="label">Numbers changed in the seller's result file</p><ul>${run.changes.map((c) => `<li>${esc(plainChange(c))}</li>`).join("")}</ul>` : `<p class="muted">The change is inside the lot's payment data (${esc(run.broken.changed)}), not in the seller's result file.</p>`}</section>`
    : "";
  const named = failed.length
    ? `<div class="named">${failed.map((c) => `<p><strong>Failed: ${esc(c.title)}</strong> <code>${esc(c.id)}</code><br>${esc(c.reason)}</p>`).join("")}</div>`
    : "";
  const mine = run.copy === "published"
    ? `<section class="card" id="mine-box">
<h2>Was my bid counted?</h2>
<p>Paste your bid receipt (the transaction id from your wallet). The lookup runs in your browser, so the shop does not learn which bid is yours.</p>
<noscript><p class="notice">This lookup needs JavaScript so your receipt stays on your device. You can also open result.json and search for your transaction id.</p></noscript>
<div class="row"><input id="mine-id" aria-label="Your bid receipt" autocomplete="off" spellcheck="false" placeholder="transaction id"><button class="btn" type="button" id="mine-go">Find my bid</button></div>
<div id="mine-out" aria-live="polite"></div>
</section><script type="module" src="/static/check.js"></script>`
    : "";
  const copyQ = encodeURIComponent(run.copy);
  return layout(ctx, "Check result", "/check", `
<span class="eyebrow">${run.broken ? "Tampered copy" : `Lot ${esc(v.lotId)}, as published`}</span>
<h1>Check this auction</h1>
<div class="verdict ${pass ? "v-pass" : "v-fail"}" role="status">
  <span class="big">${v.result}</span>
  <span>${pass ? `All ${v.checks.length} checks passed.` : `${failed.length} of ${v.checks.length} checks failed.`}</span>
</div>
${named}
${tamper}
${mine}
<section class="card">
<h2>Every check</h2>
<p class="muted">Lot key accepted as read-only, fingerprint <code>${esc(v.keyFingerprint ?? "none")}</code>. The key is not shown on this page. Servers contacted: none.</p>
${verdictBody(v)}
<p class="row"><a href="/check/report.html?copy=${copyQ}" download>Download report.html</a> <a href="/check/verdict.json?copy=${copyQ}" download>Download verdict.json</a></p>
</section>
<p class="row"><a class="btn" href="/check">${run.broken ? "Back to the honest copy" : "Try a tampered copy"}</a></p>`);
}

export function notFoundPage(ctx: PageContext): string {
  return layout(ctx, "Not found", "", `<h1>Page not found</h1><p><a href="/">Back to the shop</a></p>`);
}
