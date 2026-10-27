// Built by npm run relay:build from src/relay/check-vercel.ts. Do not edit by hand.

// src/relay/check-api.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/check.ts
import { createHash as createHash2 } from "node:crypto";

// src/read.ts
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var decoder = require2("../vendor/decoder/imani_decoder.js");
function parseAddress(address) {
  return decoder.parseAddress(address);
}
function readTransactionWithId(txHex, viewingKey) {
  const result = decoder.decryptTx(txHex, viewingKey);
  const outputs = [];
  for (const pool of ["orchard", "ironwood", "sapling"]) {
    for (const o of result[pool]) {
      outputs.push({ pool, amountZat: o.amountZat, memo: o.memo, transferType: o.transferType, recipientHex: o.recipientHex });
    }
  }
  return { txid: result.txid, outputs };
}

// src/rules.ts
function decide(bids, rules) {
  return rules.kind === "goal" ? decideGoal(bids, rules) : decideAuction(bids, rules);
}
function decideGoal(bids, rules) {
  const total = bids.reduce((s, b) => s + b.amountZat, 0);
  const reached = bids.length > 0 && total >= rules.goalZat;
  const refundsOwed = /* @__PURE__ */ new Map();
  for (const b of bids) refundsOwed.set(b.txid, reached ? 0 : b.amountZat);
  return { reserveMet: reached, winners: reached ? bids.map((b) => b.txid) : [], clearingPriceZat: 0, refundsOwed };
}
function decideAuction(bids, rules) {
  const ranked = [...bids].sort(
    (a, b) => b.amountZat - a.amountZat || a.height - b.height || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0)
  );
  const eligible = ranked.filter((b) => b.amountZat >= rules.reserveZat);
  const winning = eligible.slice(0, rules.itemCount);
  const winnerIds = new Set(winning.map((b) => b.txid));
  const reserveMet = winning.length > 0;
  const highestLoser = ranked.find((b) => !winnerIds.has(b.txid));
  const lowestWinner = winning[winning.length - 1];
  const clearingPriceZat = !reserveMet ? 0 : rules.pricing === "lowest-winning" ? Math.max(rules.reserveZat, lowestWinner.amountZat) : Math.max(rules.reserveZat, highestLoser?.amountZat ?? 0);
  const refundsOwed = /* @__PURE__ */ new Map();
  for (const b of ranked) {
    refundsOwed.set(b.txid, winnerIds.has(b.txid) ? b.amountZat - clearingPriceZat : b.amountZat);
  }
  return { reserveMet, winners: winning.map((b) => b.txid), clearingPriceZat, refundsOwed };
}
function groupBidPayments(sorted, topUps, closeHeight) {
  if (!topUps) {
    const first = /* @__PURE__ */ new Map();
    const replays = [];
    for (const b of sorted) {
      if (first.has(b.memo)) replays.push(b);
      else first.set(b.memo, b);
    }
    return { bids: [...first.values()], replays };
  }
  const merged = /* @__PURE__ */ new Map();
  const bids = [];
  for (const b of sorted) {
    if (b.height > closeHeight) {
      bids.push(b);
      continue;
    }
    const m = merged.get(b.memo);
    if (!m) {
      const copy = { ...b };
      merged.set(b.memo, copy);
      bids.push(copy);
    } else {
      m.amountZat += b.amountZat;
      m.height = b.height;
      m.outputs = Math.max(m.outputs, b.outputs);
    }
  }
  return { bids, replays: [] };
}

// src/files.ts
import { createHash } from "node:crypto";
var bidMemoPrefix = (lotId) => `bid:${lotId}:`;
var refundMemo = (lotId, bidTxid) => `refund:${lotId}:${bidTxid}`;
var refundMemoPrefix = (lotId) => `refund:${lotId}:`;
function bidMemoAddress(lotId, memo) {
  const prefix = bidMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const rest = memo.slice(prefix.length);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  const address = rest.slice(cut + 1).trim();
  return address === "" ? null : address;
}
var sealMemoPrefix = (lotId) => `seal:${lotId}:`;
var openMemoPrefix = (lotId) => `open:${lotId}:`;
var WORD = /^[A-Za-z0-9]{1,32}$/;
var HASH = /^[0-9a-f]{64}$/;
var SALT = /^[0-9a-f]{32}$/;
var AMOUNT = /^(0|[1-9][0-9]{0,15})$/;
function parseSealMemo(lotId, memo) {
  const prefix = sealMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const parts = memo.slice(prefix.length).split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [word, hash, address] = parts;
  if (!WORD.test(word) || !HASH.test(hash)) return null;
  if (parts.length === 3 && address.trim() === "") return null;
  return { word, hash, address: parts.length === 3 ? address.trim() : null };
}
function parseOpenMemo(lotId, memo) {
  const prefix = openMemoPrefix(lotId);
  if (!memo.startsWith(prefix)) return null;
  const parts = memo.slice(prefix.length).split(":");
  if (parts.length !== 3) return null;
  const [word, amount, salt] = parts;
  if (!WORD.test(word) || !AMOUNT.test(amount) || !SALT.test(salt)) return null;
  return { word, amountZat: Number(amount), salt };
}
function sealHash(lotId, word, amountZat, salt, address) {
  return createHash("sha256").update(`imani-seal/1|${lotId}|${word}|${amountZat}|${salt}|${address ?? ""}`, "utf8").digest("hex");
}

// src/scan/chain.ts
var ScanInputError = class extends Error {
};
var TXID = /^[0-9a-f]{64}$/;
function validateChainFile(c) {
  const bad = (what) => {
    throw new ScanInputError(`Input error: chain file ${what}`);
  };
  if (!c || typeof c !== "object") bad("is not a JSON object.");
  if (c.format !== "imani-chain/1") bad('must have "format": "imani-chain/1".');
  if (c.network !== "main" && c.network !== "test") bad('needs "network": "main" or "test".');
  if (!Array.isArray(c.blocks)) bad("needs a blocks list.");
  const heights = /* @__PURE__ */ new Set();
  for (const b of c.blocks) {
    if (!b || !Number.isSafeInteger(b.height) || b.height < 1) bad("has a block without a whole positive height.");
    if (heights.has(b.height)) bad(`lists block ${b.height} twice.`);
    heights.add(b.height);
    if (!Array.isArray(b.txs)) bad(`block ${b.height} needs a txs list.`);
    for (const t of b.txs) {
      if (!t || typeof t.txid !== "string" || !TXID.test(t.txid)) bad(`block ${b.height} has a transaction without a 64 hex character txid.`);
      if (typeof t.txHex !== "string" || !/^([0-9a-f]{2})+$/i.test(t.txHex)) bad(`block ${b.height} has a transaction without txHex.`);
    }
  }
}
function blocksInRange(c, from, to) {
  const byHeight = new Map(c.blocks.map((b) => [b.height, b]));
  const blocks = [];
  const missing = [];
  for (let h = from; h <= to; h++) {
    const b = byHeight.get(h);
    if (b) blocks.push(b);
    else missing.push(h);
  }
  return { blocks, missing };
}

// src/scan/scan.ts
var DEFAULT_GRACE_BLOCKS = 10;
var isHeight = (n) => Number.isSafeInteger(n) && n > 0;
function scanRange(d, graceBlocks = DEFAULT_GRACE_BLOCKS) {
  const bad = (what) => {
    throw new ScanInputError(`Input error: ${what}`);
  };
  if (!isHeight(d.openHeight)) bad("the scan needs openHeight (the first block at which a bid counts) in the disclosure file.");
  if (!isHeight(d.refundByHeight)) bad("the scan needs refundByHeight (the last block by which every refund is paid) in the disclosure file.");
  if (!isHeight(d.closeHeight)) bad("the scan needs a valid closeHeight.");
  if (!Number.isSafeInteger(graceBlocks) || graceBlocks < 0 || graceBlocks > 1e4) bad("the grace window must be a whole number of blocks from 0 to 10000.");
  const open = d.openHeight;
  const close = d.closeHeight;
  const refundBy = d.refundByHeight;
  if (open > close) bad(`openHeight ${open} is after closeHeight ${close}.`);
  if (refundBy < close) bad(`refundByHeight ${refundBy} is before closeHeight ${close}.`);
  const to = Math.max(refundBy, close + graceBlocks);
  if (to - open + 1 > 1e5) bad(`the range from ${open} to ${to} is more than 100,000 blocks.`);
  return { from: open, to, openHeight: open, closeHeight: close, refundByHeight: refundBy, graceBlocks };
}
function heightRuns(hs) {
  const runs = [];
  for (let i = 0; i < hs.length; ) {
    let j = i;
    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
    runs.push(i === j ? `${hs[i]}` : `${hs[i]} to ${hs[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}
function scanChecks(d, key, scan, add, zat, memo, short) {
  const range = scanRange(d, scan.graceBlocks);
  const hideKey = (s) => s.split(key).join("[key]");
  const inRange = scan.blocks.filter((b) => b.height >= range.from && b.height <= range.to).sort((a, b) => a.height - b.height);
  const readProblems = [];
  const all = /* @__PURE__ */ new Map();
  let txCount = 0;
  for (const b of inRange) {
    for (const t of b.txs) {
      txCount++;
      let res;
      try {
        res = readTransactionWithId(t.txHex, key);
      } catch (e) {
        readProblems.push(`transaction ${short(t.txid)} in block ${b.height} could not be read (${hideKey(String(e?.message ?? e)).slice(0, 120)})`);
        continue;
      }
      if (res.txid !== t.txid.toLowerCase()) {
        readProblems.push(`block ${b.height} lists transaction ${short(t.txid)} but its bytes are transaction ${short(res.txid)}`);
        continue;
      }
      if (all.has(res.txid)) {
        readProblems.push(`transaction ${short(res.txid)} appears in blocks ${all.get(res.txid).height} and ${b.height}`);
        continue;
      }
      all.set(res.txid, { txid: res.txid, height: b.height, outputs: res.outputs });
    }
  }
  const missing = [...new Set(scan.missing)].filter((h) => h >= range.from && h <= range.to).sort((a, b) => a - b);
  const blocksWanted = range.to - range.from + 1;
  const complete = missing.length === 0 && inRange.length === blocksWanted && readProblems.length === 0;
  const visible = [...all.values()].filter((x) => x.outputs.some((o) => o.transferType !== "internal"));
  add({
    id: "scan-blocks-read",
    level: 3,
    title: "Every block in the lot's range was read",
    status: complete ? "PASS" : "FAIL",
    reason: complete ? `Read all ${blocksWanted} blocks from ${range.from} to ${range.to} (${txCount} transactions) from ${scan.source.label}. Every transaction id was recomputed from its bytes. The lot key sees ${visible.length} of them.` : [
      `The scan is not complete, so a hidden bid could be in a block that was not read.`,
      missing.length ? `Blocks missing: ${heightRuns(missing)}.` : "",
      readProblems.length ? `${readProblems.slice(0, 5).join("; ")}${readProblems.length > 5 ? `; and ${readProblems.length - 5} more` : ""}.` : ""
    ].filter(Boolean).join(" "),
    fromChain: [`${inRange.length} of ${blocksWanted} blocks read`, `${txCount} transactions`, `${visible.length} seen by the lot key`],
    fromDisclosure: [
      `open height ${range.openHeight}`,
      `close height ${range.closeHeight}`,
      `refunds by height ${range.refundByHeight}`,
      `grace window ${range.graceBlocks} blocks after the close`
    ]
  });
  const bidPrefix = bidMemoPrefix(d.lotId);
  const refPrefix = refundMemoPrefix(d.lotId);
  const listed = /* @__PURE__ */ new Map();
  for (const t of d.transactions) if (typeof t.txid === "string") listed.set(t.txid.toLowerCase(), t.height);
  const describe = (x) => x.outputs.filter((o) => o.transferType !== "internal").map((o) => `${o.transferType} ${zat(o.amountZat)}, memo ${memo(o.memo)}`).join(" and ");
  const bidPrefixes = d.rules.kind === "sealed" ? [sealMemoPrefix(d.lotId), openMemoPrefix(d.lotId)] : [bidPrefix];
  const isBidOut = (o) => o.transferType === "incoming" && bidPrefixes.some((p) => o.memo.startsWith(p));
  const isBid = (x) => x.outputs.some(isBidOut);
  const bidAmount = (x) => x.outputs.filter(isBidOut).reduce((s, o) => s + o.amountZat, 0);
  const bidMemo = (x) => x.outputs.find(isBidOut).memo;
  const bidKind = (x) => d.rules.kind !== "sealed" ? "bid" : bidMemo(x).startsWith(openMemoPrefix(d.lotId)) ? "opening" : "seal";
  const when = (h) => h > range.closeHeight ? ", after the close" : h < range.openHeight ? ", before the open" : "";
  const chainBids = visible.filter(isBid);
  const bidMemoHasAddress = chainBids.some((x) => bidMemoAddress(d.lotId, bidMemo(x)) !== null);
  const hidden = chainBids.filter((x) => !listed.has(x.txid));
  add({
    id: "scan-hidden-bids",
    level: 3,
    title: "No bid on the chain was left out by the seller",
    status: hidden.length ? "FAIL" : "PASS",
    reason: hidden.length ? hidden.map((x) => `hidden ${bidKind(x)}: ${short(x.txid)} at block ${x.height}${when(x.height)}, ${zat(bidAmount(x))}, memo ${memo(bidMemo(x))}, is on the chain but not in the seller's disclosure.`).join(" ") : `Every one of the ${chainBids.length} bid payments the lot key sees in blocks ${range.from} to ${range.to} is in the seller's disclosure.`,
    fromChain: chainBids.map((x) => `bid ${short(x.txid)} at block ${x.height}: ${zat(bidAmount(x))}${listed.has(x.txid) ? "" : " (not listed)"}`),
    fromDisclosure: [`${listed.size} transactions listed`]
  });
  const otherUnlisted = visible.filter((x) => !isBid(x) && !listed.has(x.txid));
  add({
    id: "scan-unlisted-payments",
    level: 3,
    title: "No other payment of the lot was left out",
    status: otherUnlisted.length ? "FAIL" : "PASS",
    reason: otherUnlisted.length ? otherUnlisted.map((x) => {
      const refund = x.outputs.some((o) => o.transferType === "outgoing" && o.memo.startsWith(refPrefix));
      return `unlisted ${refund ? "refund" : "payment"}: ${short(x.txid)} at block ${x.height} (${describe(x)}) is on the chain but not in the seller's disclosure.`;
    }).join(" ") : `Every refund and other payment the lot key sees in the range is in the seller's disclosure.`,
    fromChain: visible.filter((x) => !isBid(x)).map((x) => `${short(x.txid)} at block ${x.height}: ${describe(x)}`)
  });
  const notInRange = [...listed].filter(([txid]) => !all.has(txid));
  add({
    id: "scan-listed-in-range",
    level: 3,
    title: "Every listed payment is in the lot's range",
    status: notInRange.length ? "FAIL" : "PASS",
    reason: notInRange.length ? notInRange.map(([txid, h]) => `listed payment not in the range: ${short(txid)} (the seller says block ${h}) is in none of the blocks ${range.from} to ${range.to}.`).join(" ") : `All ${listed.size} listed transactions were found in blocks ${range.from} to ${range.to}.`,
    fromChain: [`${all.size} transactions in the range`],
    fromDisclosure: [`${listed.size} transactions listed`]
  });
  const wrongHeights = [];
  let compared = 0;
  for (const [txid, claimed] of listed) {
    const seen = all.get(txid);
    if (!seen) continue;
    compared++;
    if (seen.height !== claimed) {
      const crosses = claimed <= range.closeHeight !== seen.height <= range.closeHeight;
      wrongHeights.push(
        `wrong height: ${short(txid)}, the seller says block ${claimed}, the chain shows block ${seen.height}${crosses ? ` (on the other side of the close at ${range.closeHeight})` : ""}`
      );
    }
  }
  add({
    id: "scan-heights",
    level: 3,
    title: "Block heights match the chain",
    status: wrongHeights.length ? "FAIL" : "PASS",
    reason: wrongHeights.length ? `${wrongHeights.join("; ")}.` : `All ${compared} listed transactions are in the blocks the seller states, so the on-time and late split no longer rests on the seller's word.`,
    fromChain: [...listed].filter(([t]) => all.has(t)).map(([t]) => `${short(t)} in block ${all.get(t).height}`),
    fromDisclosure: [...listed].map(([t, h]) => `${short(t)} said to be in block ${h}`)
  });
  const notes = [];
  const keys = scan.bidderKeys ?? [];
  if (keys.length) {
    const lines = [];
    const problems = [];
    for (const k of keys) {
      const bid = k.bidTxid.toLowerCase();
      const wantMemo = `${refPrefix}${bid}`;
      let lotPaid = 0;
      for (const x of all.values()) {
        for (const o of x.outputs) if (o.transferType === "outgoing" && o.memo === wantMemo) lotPaid += o.amountZat;
      }
      let received = 0;
      for (const b of inRange) {
        for (const t of b.txs) {
          let outs;
          try {
            outs = readTransactionWithId(t.txHex, k.ufvk).outputs;
          } catch {
            continue;
          }
          for (const o of outs) if (o.transferType === "incoming" && o.memo === wantMemo) received += o.amountZat;
        }
      }
      if (lotPaid === 0) problems.push(`no refund naming bid ${short(bid)} left the lot in the range`);
      else if (received !== lotPaid) problems.push(`the lot sent ${zat(lotPaid)} for bid ${short(bid)} but the bidder's key received ${zat(received)}`);
      lines.push(`bid ${short(bid)}: lot sent ${zat(lotPaid)}, bidder's key received ${zat(received)}`);
    }
    add({
      id: "scan-refund-receivers",
      level: 3,
      title: "Refunds reached the bidders who gave their key",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length ? `${problems.join("; ")}.` : `For each of the ${keys.length} bidders who gave their own viewing key, the refund the lot sent for their bid arrived in their wallet in full.`,
      fromChain: lines
    });
    notes.push(`Refund receivers were proven for ${keys.length} bid(s) whose bidder gave their own key. For other refunds the lot key shows the amount and the memo naming the bid${d.refundAddresses !== void 0 ? ", and the check refund-receivers compares where each went with the address in the bid memo or the one the disclosure lists" : ", not who received it"}.`);
  } else if (d.refundAddresses !== void 0 || bidMemoHasAddress) {
    notes.push(bidMemoHasAddress ? "Refund receivers were compared with the refund addresses the bidders wrote in their own bid memos (check refund-receivers). The seller could not choose them." : "Refund receivers were compared with the refund addresses the disclosure lists (check refund-receivers). That list is the seller's word: it proves the refunds went where the seller says, and each bidder still has to confirm the address next to their bid is theirs, or add their viewing key with --bidder-keys.");
  } else {
    notes.push("Refund receivers are not proven: the lot key shows each refund's amount and the memo naming its bid, not who received it. The seller can list a refund address per bid (refundAddresses in the disclosure), and a bidder can prove their own refund by adding their viewing key with --bidder-keys.");
  }
  return notes;
}

// src/sealed.ts
var lowerTxid = (a, b) => a < b ? -1 : a > b ? 1 : 0;
var byHeightThenTxid = (a, b) => a.height - b.height || lowerTxid(a.txid, b.txid);
function openSeals(lotId, rules, closeHeight, openByHeight, seals, openings) {
  const badDeposit = [];
  const lateSeals = [];
  const replayedSeals = [];
  const eligible = [];
  const sealedWords = /* @__PURE__ */ new Set();
  for (const s of [...seals].sort(byHeightThenTxid)) {
    if (!s.valid || s.paidZat !== rules.depositZat) badDeposit.push(s);
    else if (s.height > closeHeight) lateSeals.push(s);
    else if (sealedWords.has(s.word)) replayedSeals.push(s);
    else {
      sealedWords.add(s.word);
      eligible.push(s);
    }
  }
  const sealOfWord = new Map(eligible.map((s) => [s.word, s]));
  const sealById = new Map(eligible.map((s) => [s.txid, s]));
  const strayOpenings = [];
  const replayedOpenings = [];
  const openingOf = /* @__PURE__ */ new Map();
  for (const o of [...openings].sort(byHeightThenTxid)) {
    const inWindow = o.height > closeHeight && o.height <= openByHeight;
    const seal = o.valid ? sealOfWord.get(o.word) : void 0;
    if (!o.valid || !inWindow || !seal) strayOpenings.push(o);
    else if (openingOf.has(seal.txid)) replayedOpenings.push(o);
    else openingOf.set(seal.txid, o);
  }
  const counted = [];
  const unopened = [];
  const badOpen = [];
  for (const s of eligible) {
    const o = openingOf.get(s.txid);
    if (!o) {
      unopened.push(s);
      continue;
    }
    const inRange = Number.isSafeInteger(o.amountZat) && o.amountZat >= 1 && o.amountZat <= rules.depositZat;
    if (inRange && sealHash(lotId, s.word, o.amountZat, o.salt, s.address) === s.hash) {
      counted.push({ txid: s.txid, amountZat: o.amountZat, height: s.height });
    } else {
      badOpen.push(s);
    }
  }
  const outcome = decide(counted, { kind: "auction", itemCount: rules.itemCount, reserveZat: rules.reserveZat });
  const penalised = counted.length ? [...unopened, ...badOpen] : [];
  const penaltyTotal = penalised.length * rules.forfeitZat;
  const share = counted.length ? Math.floor(penaltyTotal / counted.length) : 0;
  const leftover = counted.length ? penaltyTotal - share * counted.length : 0;
  const leftoverTo = counted.length ? counted.map((b) => b.txid).sort(lowerTxid)[0] : null;
  const winnerIds = new Set(outcome.winners);
  const owed = /* @__PURE__ */ new Map();
  const reasons = /* @__PURE__ */ new Map();
  const set = (id, amount, reason) => {
    owed.set(id, amount);
    reasons.set(id, reason);
  };
  const openPaid = (s) => openingOf.get(s.txid)?.paidZat ?? 0;
  for (const b of counted) {
    const s = sealById.get(b.txid);
    const won = winnerIds.has(b.txid);
    set(b.txid, rules.depositZat - (won ? outcome.clearingPriceZat : 0) + openPaid(s) + share + (b.txid === leftoverTo ? leftover : 0), won ? "change" : "loser");
  }
  for (const s of unopened) set(s.txid, rules.depositZat - (counted.length ? rules.forfeitZat : 0), "unopened");
  for (const s of badOpen) set(s.txid, rules.depositZat - (counted.length ? rules.forfeitZat : 0) + openPaid(s), "bad-opening");
  for (const s of [...badDeposit, ...lateSeals, ...replayedSeals]) set(s.txid, s.paidZat, "late");
  for (const o of [...replayedOpenings, ...strayOpenings]) set(o.txid, o.paidZat, "opening");
  return {
    counted,
    unopened,
    badOpen,
    badDeposit,
    lateSeals,
    replayedSeals,
    replayedOpenings,
    strayOpenings,
    openingOf,
    penaltyTotal,
    share,
    leftover,
    leftoverTo,
    outcome,
    owed,
    reasons
  };
}

// src/check.ts
var KeyRefusedError = class extends Error {
};
var InputError = class extends Error {
};
var UFVK_SHAPE = /^uview(test)?1[02-9ac-hj-np-z]+$/;
function assertViewingKey(key, network) {
  if (typeof key !== "string" || key.trim() === "") throw new KeyRefusedError("Refused: the lot key is empty or not text.");
  const k = key.trim();
  const words = k.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]+$/i.test(w))) {
    throw new KeyRefusedError(
      "Refused: this looks like a seed phrase. A seed phrase can spend money. Never share it. Disclose only the lot's read-only viewing key (starts with uview1 or uviewtest1)."
    );
  }
  if (/^(secret-extended-key|usk|uskt|zxsk|zxtestsk|xprv|tprv|SK)/i.test(k) || /secret|spend/i.test(k.slice(0, 24))) {
    throw new KeyRefusedError(
      "Refused: this looks like a spending key. A spending key can move the money. Disclose only the lot's read-only viewing key (starts with uview1 or uviewtest1)."
    );
  }
  if (/^uivk/i.test(k)) {
    throw new KeyRefusedError(
      "Refused: this is an incoming-only viewing key. It cannot see refunds. Disclose the lot's full viewing key (starts with uview1 or uviewtest1)."
    );
  }
  if (!UFVK_SHAPE.test(k)) {
    throw new KeyRefusedError(
      "Refused: the lot key is not a unified full viewing key. Only keys that start with uview1 (main network) or uviewtest1 (test network) are accepted."
    );
  }
  const keyNetwork = k.startsWith("uviewtest1") ? "test" : "main";
  if (keyNetwork !== network) {
    throw new KeyRefusedError(`Refused: the lot key is for the ${keyNetwork} network but the disclosure says ${network}.`);
  }
  return k;
}
function keyFingerprint(key) {
  return createHash2("sha256").update(key).digest("hex").slice(0, 12);
}
var isCount = (n) => Number.isSafeInteger(n) && n >= 0;
var isAmount = (n) => Number.isSafeInteger(n) && n > 0;
var isTxid = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
function validateFiles(d, r) {
  const bad = (what) => {
    throw new InputError(`Input error: ${what}`);
  };
  if (!d || typeof d !== "object") bad("the disclosure file is not a JSON object.");
  if (d.format !== "imani-lot-disclosure/1") bad('the disclosure file must have "format": "imani-lot-disclosure/1".');
  if (typeof d.lotId !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(d.lotId)) bad("lotId must be 1 to 40 letters, digits, dots, dashes or underscores.");
  if (d.network !== "main" && d.network !== "test") bad('network must be "main" or "test".');
  if (!d.rules || typeof d.rules !== "object") bad("the disclosure file needs rules (itemCount and reserveZat, or kind goal with goalZat).");
  if (d.rules.kind !== void 0 && d.rules.kind !== "auction" && d.rules.kind !== "goal" && d.rules.kind !== "sealed") bad('the rules kind must be "auction", "goal" or "sealed".');
  if (d.rules.kind === "sealed") {
    const q = d.rules;
    if (!isAmount(q.itemCount) || !isCount(q.reserveZat)) bad("a sealed lot needs itemCount (above 0) and reserveZat in its rules.");
    if (!isAmount(q.depositZat)) bad("a sealed lot needs a deposit (depositZat) above 0 in its rules.");
    if (!isCount(q.forfeitZat) || q.forfeitZat > q.depositZat) bad("the penalty (forfeitZat) of a sealed lot must be a whole number from 0 up to the deposit.");
    if (q.reserveZat > q.depositZat) bad("the reserve of a sealed lot cannot be higher than the deposit.");
    if (!isAmount(d.openByHeight)) bad("a sealed lot needs openByHeight, the last block at which a seal can be opened.");
    if (isAmount(d.closeHeight) && d.openByHeight <= d.closeHeight) bad("openByHeight must be greater than closeHeight.");
    if (d.refundByHeight !== void 0 && isAmount(d.refundByHeight) && d.openByHeight > d.refundByHeight) bad("openByHeight cannot be after refundByHeight.");
  }
  if (d.rules.kind === void 0 || d.rules.kind === "auction") {
    if (d.rules.pricing !== void 0 && d.rules.pricing !== "highest-losing" && d.rules.pricing !== "lowest-winning") bad('the pricing rule must be "highest-losing" or "lowest-winning".');
    if (d.rules.topUps !== void 0 && typeof d.rules.topUps !== "boolean") bad("topUps in the rules must be true or false.");
  }
  if (d.rules.kind === "goal" && !isAmount(d.rules.goalZat)) bad("the goal in the rules (goalZat) must be a whole number above 0.");
  if (!Array.isArray(d.transactions)) bad("the disclosure file needs a transactions list.");
  for (const t of d.transactions) {
    if (!t || typeof t.txHex !== "string" || !/^([0-9a-f]{2})+$/i.test(t.txHex)) bad("every disclosed transaction needs txHex (hex text).");
  }
  if (d.refundAddresses !== void 0) {
    if (!Array.isArray(d.refundAddresses)) bad("refundAddresses must be a list of { bidTxid, address }.");
    for (const a of d.refundAddresses) {
      if (!a || !isTxid(a.bidTxid) || typeof a.address !== "string" || a.address.trim() === "") bad("every refundAddresses entry needs a 64 hex character bidTxid and an address.");
    }
  }
  if (!r || typeof r !== "object") bad("the result file is not a JSON object.");
  if (r.format !== "imani-lot-result/1") bad('the result file must have "format": "imani-lot-result/1".');
  if (!Array.isArray(r.bids) || !Array.isArray(r.winners) || !Array.isArray(r.refunds)) bad("the result file needs bids, winners and refunds lists.");
  if (r.totals !== void 0) {
    const t = r.totals;
    if (!t || typeof t !== "object" || !["payments", "receivedZat", "keptZat", "refundedZat"].every((k) => isCount(t[k]))) bad("totals in the result file needs payments, receivedZat, keptZat and refundedZat, each a whole number from 0 up.");
  }
  if (r.unopened !== void 0 && (!Array.isArray(r.unopened) || !r.unopened.every(isTxid))) bad("unopened in the result file must be a list of 64 hex character transaction ids.");
}
function checkLot(d, r, opts = {}) {
  validateFiles(d, r);
  const discreet = !!opts.discreet;
  const zat = (n) => discreet ? "[hidden]" : `${n.toLocaleString("en-US")} zat`;
  const memo = (m) => discreet ? "[hidden]" : JSON.stringify(m);
  const short = (t) => typeof t === "string" ? t.slice(0, 10) : String(t);
  const checks = [];
  const add = (c) => checks.push({ fromChain: [], fromSeller: [], fromDisclosure: [], ...c });
  const heightsOk = isAmount(d.closeHeight) && d.transactions.every((t) => isAmount(t.height));
  add({
    id: "close-height",
    level: 1,
    title: "Close height is valid",
    status: heightsOk ? "PASS" : "FAIL",
    reason: heightsOk ? `The lot closes at block ${d.closeHeight} and every disclosed transaction has a block height.` : "The close height or a transaction height is missing or not a whole positive number.",
    fromDisclosure: [`close height ${d.closeHeight}`, `${d.transactions.length} transactions with heights`]
  });
  const seen = /* @__PURE__ */ new Set();
  const dupTx = [];
  for (const t of d.transactions) {
    if (seen.has(t.txid)) dupTx.push(t.txid);
    seen.add(t.txid);
  }
  const txidsOk = dupTx.length === 0 && d.transactions.every((t) => isTxid(t.txid));
  add({
    id: "disclosure-txids-unique",
    level: 1,
    title: "Disclosed transaction ids are unique",
    status: txidsOk ? "PASS" : "FAIL",
    reason: txidsOk ? `All ${d.transactions.length} disclosed transaction ids are different.` : dupTx.length ? `The same transaction is listed more than once: ${dupTx.map(short).join(", ")}.` : "A disclosed transaction id is not 64 hex characters.",
    fromDisclosure: [`${d.transactions.length} transaction ids`]
  });
  const problems = [];
  const goalRules = d.rules.kind === "goal" ? d.rules : null;
  const sealedBasic = d.rules.kind === "sealed" ? d.rules : null;
  const ar = d.rules;
  const rulesOk = goalRules ? !!r.rules && r.rules.kind === "goal" && r.rules.goalZat === goalRules.goalZat : sealedBasic ? !!r.rules && r.rules.kind === "sealed" && r.rules.itemCount === sealedBasic.itemCount && r.rules.reserveZat === sealedBasic.reserveZat && r.rules.depositZat === sealedBasic.depositZat && r.rules.forfeitZat === sealedBasic.forfeitZat : isAmount(ar.itemCount) && isCount(ar.reserveZat) && r.rules && r.rules.kind !== "goal" && r.rules.kind !== "sealed" && r.rules.itemCount === ar.itemCount && r.rules.reserveZat === ar.reserveZat && r.rules.pricing === ar.pricing && r.rules.topUps === ar.topUps;
  if (r.lotId !== d.lotId) problems.push(`the result is for lot ${r.lotId}, the disclosure for lot ${d.lotId}`);
  if (!rulesOk) problems.push(goalRules ? "the rules (goal) in the result differ from the disclosure" : sealedBasic ? "the rules (item count, reserve, deposit, penalty) in the result differ from the disclosure" : "the rules (item count, reserve, pricing, top-ups) in the result differ from the disclosure");
  if (r.bidCount !== r.bids.length) problems.push(`bidCount says ${r.bidCount} but ${r.bids.length} bids are listed`);
  const listed = /* @__PURE__ */ new Map();
  for (const b of r.bids) {
    if (!isTxid(b.txid) || !isAmount(b.amountZat)) problems.push("a listed bid has a bad txid or amount");
    else if (listed.has(b.txid)) problems.push(`bid ${short(b.txid)} is listed twice`);
    else listed.set(b.txid, b.amountZat);
  }
  const winnerSet = new Set(r.winners);
  if (winnerSet.size !== r.winners.length) problems.push("a winner is listed twice");
  for (const w of r.winners) if (!listed.has(w)) problems.push(`winner ${short(w)} is not in the bid list`);
  if (r.reserveMet !== r.winners.length > 0) problems.push("reserveMet does not agree with the winners list");
  const refundsByBid = /* @__PURE__ */ new Map();
  for (const f of r.refunds) {
    if (goalRules && winnerSet.has(f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} but a payment counted towards a reached goal is kept, never refunded`);
    if (!isTxid(f.bidTxid) || !isAmount(f.amountZat)) problems.push("a listed refund has a bad bid txid or amount");
    else if (f.memo !== refundMemo(r.lotId, f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} does not carry the memo "refund:<lot>:<bid txid>"`);
    else if (f.reason !== "late" && !(sealedBasic && (f.reason === "unopened" || f.reason === "bad-opening" || f.reason === "opening")) && !listed.has(f.bidTxid)) problems.push(`refund for ${short(f.bidTxid)} points to a bid that is not listed`);
    else if (f.reason === "change" && !winnerSet.has(f.bidTxid)) problems.push(`change refund for ${short(f.bidTxid)} but that bid did not win`);
    refundsByBid.set(f.bidTxid, (refundsByBid.get(f.bidTxid) ?? 0) + (f.amountZat || 0));
  }
  for (const [txid, amount] of listed) {
    if (sealedBasic) {
      if (!winnerSet.has(txid) && refundsByBid.get(txid) === void 0) problems.push(`losing bid ${short(txid)} has no refund listed`);
    } else if (!winnerSet.has(txid) && refundsByBid.get(txid) !== amount) {
      problems.push(`losing bid ${short(txid)} is not listed as refunded in full`);
    }
  }
  if (!isCount(r.clearingPriceZat)) problems.push("the clearing price is not a whole number");
  if (goalRules && r.clearingPriceZat !== 0) problems.push("a goal round has no price, so the clearing price must be 0");
  if (goalRules && r.winners.length > 0 && r.winners.length !== r.bids.length) problems.push("when the goal is reached every listed payment counts, but some are not marked as counted");
  add({
    id: "result-consistent",
    level: 1,
    title: "Seller's result file is consistent with itself",
    status: problems.length ? "FAIL" : "PASS",
    reason: problems.length ? `The result file contradicts itself: ${problems.join("; ")}.` : goalRules ? "Payment count, counted payments, goal outcome and refunds in the result file agree with each other and with the published goal." : "Bid count, winners, reserve and refunds in the result file agree with each other and with the published rules.",
    fromSeller: goalRules ? [`${r.bidCount} payments`, `${r.winners.length} counted`, `${r.refunds.length} refunds`] : [`${r.bidCount} bids`, `${r.winners.length} winners`, `${r.refunds.length} refunds`],
    fromDisclosure: [goalRules ? `rules: goal ${zat(goalRules.goalZat)}` : sealedBasic ? `rules: sealed lot, ${ar.itemCount} items, reserve ${zat(ar.reserveZat)}, deposit ${zat(sealedBasic.depositZat)}, penalty ${zat(sealedBasic.forfeitZat)}` : `rules: ${ar.itemCount} items, reserve ${zat(ar.reserveZat)}`]
  });
  if (goalRules) {
    const listedTotal = r.bids.reduce((s, b) => s + (b.amountZat || 0), 0);
    const reachedByList = r.bids.length > 0 && listedTotal >= goalRules.goalZat;
    const goalOk = reachedByList === r.reserveMet;
    add({
      id: "goal-reached",
      level: 1,
      title: "The goal outcome matches the listed payments",
      status: goalOk ? "PASS" : "FAIL",
      reason: goalOk ? `The listed payments add up to ${zat(listedTotal)} against a goal of ${zat(goalRules.goalZat)}: the goal was ${reachedByList ? "" : "not "}reached, as the seller says.` : `The listed payments add up to ${zat(listedTotal)} against a goal of ${zat(goalRules.goalZat)}, so the goal was ${reachedByList ? "" : "not "}reached, but the seller says it was ${r.reserveMet ? "" : "not "}reached.`,
      fromSeller: [`listed payments ${zat(listedTotal)}`, `goal reached: ${r.reserveMet}`],
      fromDisclosure: [`goal ${zat(goalRules.goalZat)}`]
    });
  }
  const winnerCountOk = goalRules ? r.winners.length === 0 || r.winners.length === r.bids.length : r.winners.length <= Math.min(ar.itemCount, r.bids.length);
  add({
    id: "winner-count",
    level: 1,
    title: goalRules ? "Either every payment counts or none does" : "Winner count fits the lot",
    status: winnerCountOk ? "PASS" : "FAIL",
    reason: goalRules ? winnerCountOk ? r.winners.length ? `All ${r.winners.length} listed payments count towards the goal.` : "The goal was not reached, so no payment counts." : `${r.winners.length} of ${r.bids.length} listed payments are marked as counted, but a reached goal counts all of them.` : winnerCountOk ? `${r.winners.length} winners, no more than the ${ar.itemCount} items and the ${r.bids.length} bids.` : `${r.winners.length} winners is more than the ${ar.itemCount} items or the ${r.bids.length} bids.`,
    fromSeller: goalRules ? [`${r.winners.length} counted`, `${r.bids.length} payments`] : [`${r.winners.length} winners`, `${r.bids.length} bids`],
    fromDisclosure: goalRules ? [`goal ${zat(goalRules.goalZat)}`] : [`${ar.itemCount} items`]
  });
  const highest = Math.max(0, ...r.bids.map((b) => b.amountZat || 0));
  const lowestWinning = !goalRules && !sealedBasic && ar.pricing === "lowest-winning";
  const listedAmount = new Map(r.bids.map((b) => [b.txid, b.amountZat]));
  const lowestListedWinner = Math.min(...r.winners.map((w) => listedAmount.get(w) ?? Infinity));
  const priceOk = goalRules ? r.clearingPriceZat === 0 : r.winners.length ? r.clearingPriceZat >= ar.reserveZat && r.clearingPriceZat <= highest && (!lowestWinning || r.clearingPriceZat === Math.max(ar.reserveZat, lowestListedWinner)) : r.clearingPriceZat === 0;
  add({
    id: "clearing-range",
    level: 1,
    title: goalRules ? "No price is set in a goal round" : "Clearing price is between the reserve and the highest bid",
    status: priceOk ? "PASS" : "FAIL",
    reason: goalRules ? priceOk ? "Payments are kept at their own amount, so no price is set (0 in the file)." : `Payments are kept at their own amount, so no price should be set, but the file sets ${zat(r.clearingPriceZat)}.` : priceOk ? r.winners.length ? lowestWinning ? `Clearing price ${zat(r.clearingPriceZat)} is the lowest listed winning bid, as the lowest-winning rule says.` : `Clearing price ${zat(r.clearingPriceZat)} is not below the reserve ${zat(ar.reserveZat)} and not above the highest listed bid ${zat(highest)}.` : "No winners, and the clearing price is 0." : r.winners.length ? lowestWinning && r.clearingPriceZat >= ar.reserveZat && r.clearingPriceZat <= highest ? `Clearing price ${zat(r.clearingPriceZat)} is not the lowest listed winning bid ${zat(Math.max(ar.reserveZat, lowestListedWinner))}, which the lowest-winning rule requires.` : `Clearing price ${zat(r.clearingPriceZat)} is outside the range from the reserve ${zat(ar.reserveZat)} to the highest listed bid ${zat(highest)}.` : "There are no winners but the clearing price is not 0.",
    fromSeller: goalRules ? [`price ${zat(r.clearingPriceZat)}`] : [`clearing price ${zat(r.clearingPriceZat)}`, `highest listed bid ${zat(highest)}`],
    fromDisclosure: [goalRules ? "no price in a goal round" : `reserve ${zat(ar.reserveZat)}`]
  });
  if (r.totals) {
    const t = r.totals;
    const listedRefunds = r.refunds.reduce((s, f) => s + (f.amountZat || 0), 0);
    const keptByRule = goalRules ? r.winners.reduce((s, w) => s + (listedAmount.get(w) ?? 0), 0) : r.clearingPriceZat * r.winners.length;
    const problems2 = [];
    if (t.receivedZat !== t.keptZat + t.refundedZat) problems2.push(`received ${zat(t.receivedZat)} is not kept ${zat(t.keptZat)} plus refunded ${zat(t.refundedZat)}`);
    if (!sealedBasic && t.keptZat !== keptByRule) problems2.push(`kept is ${zat(t.keptZat)} but the winners pay ${zat(keptByRule)} in all`);
    if (t.refundedZat !== listedRefunds) problems2.push(`refunded is ${zat(t.refundedZat)} but the listed refunds add up to ${zat(listedRefunds)}`);
    const lateListed = r.refunds.filter((f) => f.reason === "late").length;
    if (t.payments < r.bids.length + lateListed) problems2.push(`${t.payments} payments is fewer than the ${r.bids.length} bids plus ${lateListed} late payments the seller lists`);
    add({
      id: "published-totals",
      level: 1,
      title: "Published totals add up",
      status: problems2.length ? "FAIL" : "PASS",
      reason: problems2.length ? `The published totals do not add up: ${problems2.join("; ")}.` : `Received ${zat(t.receivedZat)} = kept ${zat(t.keptZat)} + refunded ${zat(t.refundedZat)}, and the kept and refunded figures match the winners and the listed refunds.`,
      fromSeller: [`${t.payments} payments`, `received ${zat(t.receivedZat)}`, `kept ${zat(t.keptZat)}`, `refunded ${zat(t.refundedZat)}`]
    });
  }
  const basicLevel = checks.every((c) => c.status === "PASS") ? "PASS" : "FAIL";
  let keyLevel = "not run";
  let keyLevelNote = "";
  let fingerprint = null;
  let sealedSummary;
  if (opts.basicOnly) {
    keyLevelNote = "Basic level only was asked for. The key level was not run.";
  } else if (d.ufvk === void 0 || d.ufvk === null || d.ufvk === "") {
    keyLevelNote = "The disclosure has no lot key, so only the basic level ran.";
  } else {
    const key = assertViewingKey(d.ufvk, d.network);
    fingerprint = keyFingerprint(key);
    sealedSummary = keyChecks(d, r, key, add, zat, memo, short);
    keyLevel = checks.filter((c) => c.level === 2).every((c) => c.status === "PASS") ? "PASS" : "FAIL";
    keyLevelNote = "Amounts, memos and refunds were read from the disclosed transactions with the lot key.";
  }
  let scanLevel = "not run";
  let scanNotes = [];
  let range = null;
  let scanSource = null;
  if (opts.scan) {
    const { serversContacted: _s, ...src } = opts.scan.source;
    scanSource = src;
    if (keyLevel === "not run") {
      scanNotes = ["The scan level needs the lot key and the key level, so it was not run."];
    } else {
      range = scanRange(d, opts.scan.graceBlocks);
      const key = assertViewingKey(d.ufvk, d.network);
      scanNotes = scanChecks(d, key, opts.scan, add, zat, memo, short);
      scanLevel = checks.filter((c) => c.level === 3).every((c) => c.status === "PASS") ? "PASS" : "FAIL";
    }
  }
  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  return {
    tool: "imani check",
    lotId: d.lotId,
    network: d.network,
    result: failed.length ? "FAIL" : "PASS",
    basicLevel,
    keyLevel,
    keyLevelNote,
    scanLevel,
    scanNotes,
    scanRange: range,
    scanSource,
    keyFingerprint: fingerprint,
    serversContacted: opts.scan ? [...opts.scan.source.serversContacted] : [],
    discreet,
    ...sealedSummary ? { sealed: sealedSummary } : {},
    failed,
    checks
  };
}
function keyChecks(d, r, key, add, zat, memo, short) {
  const goalRules = d.rules.kind === "goal" ? d.rules : null;
  const sealedRules = d.rules.kind === "sealed" ? d.rules : null;
  const ar = d.rules;
  const read = [];
  for (const t of d.transactions) {
    let res;
    try {
      res = readTransactionWithId(t.txHex, key);
    } catch (e) {
      const msg = String(e?.message ?? e).split(key).join("[key]");
      throw new InputError(`Input error: transaction ${short(t.txid)} could not be read (${msg}).`);
    }
    read.push({ txid: res.txid, listedTxid: t.txid, height: t.height, outputs: res.outputs });
  }
  const wrongIds = read.filter((x) => x.txid !== x.listedTxid);
  add({
    id: "txids-match-bytes",
    level: 2,
    title: "Transaction ids match the transaction bytes",
    status: wrongIds.length ? "FAIL" : "PASS",
    reason: wrongIds.length ? `${wrongIds.length} listed transaction ids do not match their bytes: ${wrongIds.map((x) => short(x.listedTxid)).join(", ")}.` : `Each of the ${read.length} transaction ids was recomputed from the bytes and matches.`,
    fromChain: [`${read.length} transaction ids recomputed from the bytes`]
  });
  const bidPrefix = bidMemoPrefix(d.lotId);
  const refPrefix = refundMemoPrefix(d.lotId);
  const sealPrefix = sealMemoPrefix(d.lotId);
  const openPrefix = openMemoPrefix(d.lotId);
  const bids = /* @__PURE__ */ new Map();
  const sealTxs = /* @__PURE__ */ new Map();
  const openTxs = /* @__PURE__ */ new Map();
  const outside = [];
  const refunds = [];
  for (const x of read) {
    for (const o of x.outputs) {
      if (o.transferType === "incoming") {
        if (sealedRules && (o.memo.startsWith(sealPrefix) || o.memo.startsWith(openPrefix))) {
          const into = o.memo.startsWith(sealPrefix) ? sealTxs : openTxs;
          const prev = into.get(x.txid);
          if (prev) {
            prev.amountZat += o.amountZat;
            prev.outputs += 1;
          } else {
            into.set(x.txid, { txid: x.txid, amountZat: o.amountZat, height: x.height, memo: o.memo, outputs: 1 });
          }
        } else if (!sealedRules && o.memo.startsWith(bidPrefix)) {
          const prev = bids.get(x.txid);
          if (prev) {
            prev.amountZat += o.amountZat;
            prev.outputs += 1;
          } else {
            bids.set(x.txid, { txid: x.txid, amountZat: o.amountZat, height: x.height, memo: o.memo, outputs: 1 });
          }
        } else {
          outside.push({ txid: x.txid, amountZat: o.amountZat, memo: o.memo });
        }
      } else if (o.transferType === "outgoing" && o.memo.startsWith(refPrefix)) {
        refunds.push({ txid: x.txid, bidTxid: o.memo.slice(refPrefix.length), amountZat: o.amountZat, pool: o.pool, recipientHex: o.recipientHex });
      }
    }
  }
  const topUps = !goalRules && !sealedRules && ar.topUps === true;
  const grouped = groupBidPayments([...bids.values()].sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : 1)), topUps, d.closeHeight);
  const replays = grouped.replays;
  const topUpPayments = topUps ? [...bids.values()].filter((b) => b.height <= d.closeHeight).length - grouped.bids.filter((b) => b.height <= d.closeHeight).length : 0;
  let allBids = grouped.bids;
  const mergedAmount = new Map(grouped.bids.map((b) => [b.txid, b.amountZat]));
  let onTime = allBids.filter((b) => b.height <= d.closeHeight);
  let late = allBids.filter((b) => b.height > d.closeHeight);
  let lateIds = new Set(late.map((b) => b.txid));
  let sealedOut = null;
  let skipIds = lateIds;
  let sealedAmount = (txid) => topUps ? mergedAmount.get(txid) : bids.get(txid)?.amountZat;
  if (sealedRules) {
    const sealFacts = [...sealTxs.values()].map((t) => {
      const m = parseSealMemo(d.lotId, t.memo);
      return { txid: t.txid, height: t.height, paidZat: t.amountZat, valid: !!m && t.outputs === 1, word: m?.word ?? "", hash: m?.hash ?? "", address: m?.address ?? null };
    });
    const openFacts = [...openTxs.values()].map((t) => {
      const m = parseOpenMemo(d.lotId, t.memo);
      return { txid: t.txid, height: t.height, paidZat: t.amountZat, valid: !!m && t.outputs === 1, word: m?.word ?? "", amountZat: m?.amountZat ?? 0, salt: m?.salt ?? "" };
    });
    const so = openSeals(d.lotId, sealedRules, d.closeHeight, d.openByHeight, sealFacts, openFacts);
    sealedOut = so;
    for (const [id, t] of sealTxs) bids.set(id, t);
    const asBid = (s) => sealTxs.get(s.txid);
    const counted = new Set(so.counted.map((b) => b.txid));
    allBids = so.counted.map((b) => ({ ...asBid(b), amountZat: b.amountZat }));
    onTime = allBids;
    late = so.lateSeals.map(asBid);
    lateIds = new Set(late.map((b) => b.txid));
    skipIds = new Set([...sealTxs.keys()].filter((id) => !counted.has(id)));
    const opened = /* @__PURE__ */ new Map();
    for (const s of [...so.badOpen, ...so.counted]) {
      const o = so.openingOf.get(s.txid);
      if (o) opened.set(s.txid, o.amountZat);
    }
    sealedAmount = (txid) => opened.get(txid);
  }
  add({
    id: "key-hygiene",
    level: 2,
    title: "Lot key shows only this lot's payments",
    status: outside.length ? "FAIL" : "PASS",
    reason: outside.length ? `The key shows ${outside.length} payment(s) into this address that are not ${sealedRules ? "seals or openings" : "bids"} for ${d.lotId}. Publishing this key exposes them. Use a fresh one-time key for every lot.` : `Every incoming payment the key shows is a ${sealedRules ? "seal or an opening" : "bid"} for ${d.lotId}.`,
    fromChain: outside.map((o) => `outside payment ${short(o.txid)}: ${zat(o.amountZat)}, memo ${memo(o.memo)}`)
  });
  const sellerIds = r.bids.map((b) => b.txid).filter((t) => !skipIds.has(t));
  const onTimeIds = new Set(onTime.map((b) => b.txid));
  const notOnChain = sellerIds.filter((t) => !onTimeIds.has(t));
  const sellerIdSet = new Set(sellerIds);
  const notListed = [...onTimeIds].filter((t) => !sellerIdSet.has(t));
  const countOk = notOnChain.length === 0 && notListed.length === 0 && sellerIds.length === onTime.length;
  add({
    id: "bid-count",
    level: 2,
    title: "Bid count matches the chain",
    status: countOk ? "PASS" : "FAIL",
    reason: countOk ? `The seller lists ${sellerIds.length} on-time bids and the key shows the same ${onTime.length}.` : [
      `The seller lists ${sellerIds.length} on-time bids, the key shows ${onTime.length}.`,
      notOnChain.length ? `Not found on the chain: ${notOnChain.map(short).join(", ")}.` : "",
      notListed.length ? `Missing from the seller's list: ${notListed.map(short).join(", ")}.` : ""
    ].filter(Boolean).join(" "),
    fromChain: [`${onTime.length} on-time bid payments`],
    fromSeller: [`${sellerIds.length} on-time bids listed`]
  });
  const wrongAmounts = [];
  for (const b of r.bids) {
    const chainAmount = sealedAmount(b.txid);
    if (chainAmount !== void 0 && chainAmount !== b.amountZat) wrongAmounts.push(`${short(b.txid)}: seller says ${zat(b.amountZat)}, chain shows ${zat(chainAmount)}`);
  }
  add({
    id: "bid-amounts",
    level: 2,
    title: "Each bid amount matches the chain",
    status: wrongAmounts.length ? "FAIL" : "PASS",
    reason: wrongAmounts.length ? `${wrongAmounts.length} bid amount(s) differ: ${wrongAmounts.join("; ")}.` : "Every listed bid amount equals the amount the key reads from the chain.",
    fromChain: allBids.map((b) => `bid ${short(b.txid)}: ${zat(b.amountZat)}`),
    fromSeller: r.bids.map((b) => `bid ${short(b.txid)}: ${zat(b.amountZat)}`)
  });
  const countedLate = r.bids.filter((b) => lateIds.has(b.txid));
  add({
    id: "no-late-bids",
    level: 2,
    title: "No bid after the close was counted",
    status: countedLate.length ? "FAIL" : "PASS",
    reason: countedLate.length ? `The seller counted ${countedLate.length} bid(s) paid after the close at block ${d.closeHeight}: ${countedLate.map((b) => `${short(b.txid)} at block ${bids.get(b.txid).height}`).join(", ")}.` : late.length ? `${late.length} bid(s) arrived after block ${d.closeHeight} and the seller did not count them.` : `No bid arrived after block ${d.closeHeight}.`,
    fromChain: late.map((b) => `late bid ${short(b.txid)}: ${zat(b.amountZat)}`),
    fromDisclosure: [`close height ${d.closeHeight}`, ...late.map((b) => `bid ${short(b.txid)} at block ${b.height}`)]
  });
  const memoCount = /* @__PURE__ */ new Map();
  for (const b of [...allBids, ...replays]) memoCount.set(b.memo, [...memoCount.get(b.memo) ?? [], b.txid]);
  let dupMemos = topUps ? [] : [...memoCount.values()].filter((ids) => ids.length > 1);
  let multi = (topUps ? [...bids.values()] : allBids).filter((b) => b.outputs > 1);
  if (sealedOut) {
    dupMemos = [...sealedOut.replayedSeals.map((s) => [s.txid]), ...sealedOut.replayedOpenings.map((o) => [o.txid])];
    multi = [...sealTxs.values(), ...openTxs.values()].filter((b) => b.outputs > 1);
  }
  const dupOk = dupMemos.length === 0 && multi.length === 0;
  add({
    id: "no-duplicate-bids",
    level: 2,
    title: "No duplicate or replayed bid",
    status: dupOk ? "PASS" : "FAIL",
    reason: dupOk ? sealedOut ? "Every seal word and every opening word is used once, and every transaction holds one seal or one opening." : topUps ? `Top-ups are allowed in this lot: ${topUpPayments} extra payment(s) under an existing bid memo were added to that bid, and every bid transaction holds one payment.` : "Every bid memo is used once and every bid transaction holds one bid." : [
      ...sealedOut ? [
        ...sealedOut.replayedSeals.map((s) => `Seal ${short(s.txid)} repeats a word that was already sealed, a replayed seal.`),
        ...sealedOut.replayedOpenings.map((o) => `Opening ${short(o.txid)} repeats a word that was already opened, a replayed opening.`)
      ] : dupMemos.map((ids) => `The same bid memo appears in ${ids.length} transactions (${ids.map(short).join(", ")}), a replayed bid.`),
      ...multi.map((b) => `Transaction ${short(b.txid)} holds ${b.outputs} bids.`)
    ].join(" "),
    fromChain: sealedOut ? [`${sealTxs.size} seal payments, ${openTxs.size} opening payments`, `${sealedOut.replayedSeals.length + sealedOut.replayedOpenings.length} replayed`] : [`${allBids.length + replays.length} bid payments`, `${replays.length} replayed`]
  });
  const outcome = sealedOut ? sealedOut.outcome : decide(onTime, d.rules);
  const sellerWinnerSet = new Set(r.winners);
  const sameWinners = outcome.winners.length === r.winners.length && outcome.winners.every((w) => sellerWinnerSet.has(w));
  const samePrice = outcome.clearingPriceZat === r.clearingPriceZat;
  add({
    id: "winners-and-price",
    level: 2,
    title: goalRules ? "Counted payments recomputed from the chain" : "Winners and clearing price recomputed from the chain",
    status: sameWinners && samePrice ? "PASS" : "FAIL",
    reason: goalRules ? sameWinners && samePrice ? `Recomputed from the on-time payments: ${outcome.winners.length ? `all ${outcome.winners.length} count towards the goal` : "none count, the goal was missed"}. Same as the seller.` : `From the on-time payments, the counted payments should be ${outcome.winners.map(short).join(", ") || "none"}; the seller says ${r.winners.map(short).join(", ") || "none"}.` : sameWinners && samePrice ? `Recomputed from the on-time bids: winners ${outcome.winners.map(short).join(", ") || "none"}, clearing price ${zat(outcome.clearingPriceZat)}. Same as the seller.` : [
      !sameWinners ? `Winners should be ${outcome.winners.map(short).join(", ") || "none"}, the seller says ${r.winners.map(short).join(", ") || "none"}.` : "",
      !samePrice ? `Clearing price should be ${zat(outcome.clearingPriceZat)}, the seller says ${zat(r.clearingPriceZat)}.` : ""
    ].filter(Boolean).join(" "),
    fromChain: goalRules ? [`counted ${outcome.winners.map(short).join(", ") || "none"}`] : [`winners ${outcome.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(outcome.clearingPriceZat)}`],
    fromSeller: goalRules ? [`counted ${r.winners.map(short).join(", ") || "none"}`] : [`winners ${r.winners.map(short).join(", ") || "none"}`, `clearing price ${zat(r.clearingPriceZat)}`],
    fromDisclosure: [goalRules ? `goal ${zat(goalRules.goalZat)}` : `${ar.itemCount} items, reserve ${zat(ar.reserveZat)}`]
  });
  add({
    id: "reserve",
    level: 2,
    title: goalRules ? "Goal outcome from the chain" : "Reserve outcome",
    status: outcome.reserveMet === r.reserveMet ? "PASS" : "FAIL",
    reason: goalRules ? outcome.reserveMet === r.reserveMet ? `The on-time payments ${outcome.reserveMet ? "reach" : "fall short of"} the goal, as the seller says.` : `The seller says the goal was ${r.reserveMet ? "" : "not "}reached, but the on-time payments on the chain ${outcome.reserveMet ? "reach" : "fall short of"} it.` : outcome.reserveMet === r.reserveMet ? `The reserve was ${outcome.reserveMet ? "" : "not "}met, as the seller says.` : `The seller says the reserve was ${r.reserveMet ? "" : "not "}met, the chain says it was ${outcome.reserveMet ? "" : "not "}met.`,
    fromChain: [goalRules ? `goal reached: ${outcome.reserveMet}` : `reserve met: ${outcome.reserveMet}`],
    fromSeller: [goalRules ? `goal reached: ${r.reserveMet}` : `reserve met: ${r.reserveMet}`]
  });
  const owed = sealedOut ? new Map(sealedOut.owed) : new Map(outcome.refundsOwed);
  if (!sealedOut) for (const b of [...late, ...replays]) owed.set(b.txid, b.amountZat);
  const paid = /* @__PURE__ */ new Map();
  for (const f of refunds) paid.set(f.bidTxid, (paid.get(f.bidTxid) ?? 0) + f.amountZat);
  const refundProblems = [];
  for (const [txid, amount] of owed) {
    if (amount === 0) continue;
    const got = paid.get(txid);
    if (got === void 0) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but no refund was found`);
    else if (got !== amount) refundProblems.push(`bid ${short(txid)} is owed ${zat(amount)} but was refunded ${zat(got)}`);
  }
  for (const [txid, got] of paid) {
    if (!(owed.get(txid) ?? 0)) refundProblems.push(`${zat(got)} was paid out as a refund for ${short(txid)}, but no bid the lot key sees is owed anything under that id`);
  }
  const owedCount = [...owed.values()].filter((a) => a > 0).length;
  add({
    id: "refunds-paid",
    level: 2,
    title: "Every refund paid in the exact amount",
    status: refundProblems.length ? "FAIL" : "PASS",
    reason: refundProblems.length ? `${refundProblems.length} refund problem(s): ${refundProblems.join("; ")}.` : sealedOut ? `All ${owedCount} refunds owed (deposits back, winners less the clearing price, penalties taken from seals not opened and shared to the bidders who opened, stray payments in full) were paid exactly, each with a memo naming its payment.` : `All ${owedCount} refunds owed (losers in full, winners their bid minus the clearing price, late bids in full) were paid exactly, each with a memo naming its bid.`,
    fromChain: [
      ...[...owed].filter(([, a]) => a > 0).map(([t, a]) => `owed to ${short(t)}: ${zat(a)}`),
      ...refunds.map((f) => `refund for ${short(f.bidTxid)}: ${zat(f.amountZat)}`)
    ]
  });
  const memoAddr = /* @__PURE__ */ new Map();
  for (const b of bids.values()) {
    const a = sealedRules ? parseSealMemo(d.lotId, b.memo)?.address ?? null : bidMemoAddress(d.lotId, b.memo);
    if (a) memoAddr.set(b.txid, a);
  }
  if (d.refundAddresses !== void 0 || memoAddr.size > 0) {
    const problems = [];
    const listedAddr = /* @__PURE__ */ new Map();
    for (const a of d.refundAddresses ?? []) {
      const k = a.bidTxid.toLowerCase();
      if (listedAddr.has(k)) problems.push(`two refund addresses are listed for bid ${short(k)}`);
      listedAddr.set(k, a.address.trim());
    }
    for (const [txid, addr] of memoAddr) {
      const listed = listedAddr.get(txid);
      if (listed !== void 0 && listed !== addr) problems.push(`the seller's list gives a different refund address for bid ${short(txid)} than the one in the bid memo`);
      listedAddr.set(txid, addr);
    }
    const parsed = /* @__PURE__ */ new Map();
    for (const [txid, addr] of listedAddr) {
      if (!bids.has(txid)) {
        problems.push(`a refund address is listed for ${short(txid)}, which is not a bid the lot key sees`);
        continue;
      }
      try {
        const p = parseAddress(addr);
        if (p.network !== d.network) problems.push(`the address given for bid ${short(txid)} is for the ${p.network} network, the lot is on ${d.network}`);
        else parsed.set(txid, p);
      } catch (e) {
        problems.push(`the address given for bid ${short(txid)} is not a usable shielded address (${String(e?.message ?? e).slice(0, 80)})`);
      }
    }
    let checked = 0;
    for (const [txid, amount] of owed) {
      if (amount === 0) continue;
      if (sealedRules && !bids.has(txid)) continue;
      if (!listedAddr.has(txid)) {
        problems.push(`no refund address is given for bid ${short(txid)} (not in its bid memo and not in the seller's list)`);
        continue;
      }
      const p = parsed.get(txid);
      if (!p) continue;
      for (const f of refunds.filter((f2) => f2.bidTxid === txid)) {
        checked++;
        const want = f.pool === "sapling" ? p.sapling : p.orchard;
        if (want === null) problems.push(`the refund for bid ${short(txid)} was paid into the ${f.pool} pool but the address given has no ${f.pool === "sapling" ? "Sapling" : "Orchard"} receiver`);
        else if (want !== f.recipientHex) problems.push(`the refund for bid ${short(txid)} (${zat(f.amountZat)}, transaction ${short(f.txid)}) went to a different address than the one given for that bid`);
      }
    }
    add({
      id: "refund-receivers",
      level: 2,
      title: "Each refund went to the address given for its bid",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length ? `${problems.join("; ").replace(/^./, (c) => c.toUpperCase())}.` : `All ${checked} refund payments went to the address given for their bid. The lot key recovered the receiver of each one. ${memoAddr.size > 0 ? `${memoAddr.size} of the addresses were written by the bidders in their own bid memos, so the seller could not choose them.` : "The list itself is the seller's word: each bidder should confirm that the address next to their bid is theirs."}`,
      fromChain: [`${refunds.length} refund payments, receiver recovered with the lot key`, `${memoAddr.size} refund addresses read from bid memos`],
      fromDisclosure: [`${d.refundAddresses?.length ?? 0} refund addresses listed`]
    });
  }
  const received = sealedRules ? [...sealTxs.values(), ...openTxs.values()].reduce((s, b) => s + b.amountZat, 0) : [...allBids, ...replays].reduce((s, b) => s + b.amountZat, 0);
  const sellerRefunds = r.refunds.filter((f) => bids.has(f.bidTxid) || openTxs.has(f.bidTxid)).reduce((s, f) => s + f.amountZat, 0);
  const kept = goalRules ? r.winners.reduce((s, w) => s + (bids.get(w)?.amountZat ?? 0), 0) : r.clearingPriceZat * r.winners.length;
  const FEE_ALLOWANCE = 0;
  const totalOk = sellerRefunds + kept === received - FEE_ALLOWANCE;
  add({
    id: "refund-total",
    level: 2,
    title: "Refund total balances",
    status: totalOk ? "PASS" : "FAIL",
    reason: totalOk ? `Refunds ${zat(sellerRefunds)} plus winners' payments ${zat(kept)} equal the ${zat(received)} received, with no fees taken from bidders.` : `Refunds ${zat(sellerRefunds)} plus winners' payments ${zat(kept)} make ${zat(sellerRefunds + kept)}, but ${zat(received)} was received. The difference is ${zat(Math.abs(received - sellerRefunds - kept))}.`,
    fromChain: [`received ${zat(received)}`],
    fromSeller: [`refunds listed ${zat(sellerRefunds)}`, `winners' payments ${zat(kept)}`]
  });
  if (r.totals) {
    const t = r.totals;
    const chainPayments = sealedRules ? sealTxs.size : bids.size;
    const chainRefunded = refunds.reduce((s, f) => s + f.amountZat, 0);
    const problems = [];
    if (t.payments !== chainPayments) problems.push(`the totals say ${t.payments} payments, the key shows ${chainPayments}`);
    if (t.receivedZat !== received) problems.push(`the totals say ${zat(t.receivedZat)} was received, the key shows ${zat(received)}`);
    if (t.refundedZat !== chainRefunded) problems.push(`the totals say ${zat(t.refundedZat)} was refunded, the chain shows ${zat(chainRefunded)}`);
    if (t.keptZat !== received - chainRefunded) problems.push(`the totals say the seller keeps ${zat(t.keptZat)}, the chain shows ${zat(received - chainRefunded)} kept`);
    add({
      id: "published-totals-chain",
      level: 2,
      title: "Published totals match the chain",
      status: problems.length ? "FAIL" : "PASS",
      reason: problems.length ? `The published totals differ from the chain: ${problems.join("; ")}.` : `${chainPayments} payments, ${zat(received)} received, ${zat(chainRefunded)} refunded and ${zat(received - chainRefunded)} kept, exactly as published.`,
      fromChain: [`${chainPayments} payments`, `received ${zat(received)}`, `refunded ${zat(chainRefunded)}`, `kept ${zat(received - chainRefunded)}`],
      fromSeller: [`${t.payments} payments`, `received ${zat(t.receivedZat)}`, `refunded ${zat(t.refundedZat)}`, `kept ${zat(t.keptZat)}`]
    });
  }
  if (sealedRules && sealedOut) {
    const so = sealedOut;
    const listedIds = new Set(r.bids.map((b) => b.txid));
    const notBids = [
      ...so.badDeposit.map((x) => ({ txid: x.txid, why: x.valid ? `paid ${zat(x.paidZat)} instead of the deposit ${zat(sealedRules.depositZat)}` : "its memo is not a well-formed seal" })),
      ...so.lateSeals.map((x) => ({ txid: x.txid, why: `arrived at block ${x.height}, after the close at block ${d.closeHeight}` })),
      ...so.replayedSeals.map((x) => ({ txid: x.txid, why: "repeats a word that was already sealed" }))
    ];
    const countedBad = notBids.filter((x) => listedIds.has(x.txid));
    const onTimeSeals = sealTxs.size - notBids.length;
    add({
      id: "seal-deposits",
      level: 2,
      title: "Every counted seal paid exactly the deposit, on time",
      status: countedBad.length ? "FAIL" : "PASS",
      reason: countedBad.length ? `The seller counted ${countedBad.length} seal(s) that cannot count: ${countedBad.map((x) => `${short(x.txid)} ${x.why}`).join("; ")}.` : `${onTimeSeals} seals paid exactly the deposit ${zat(sealedRules.depositZat)} by block ${d.closeHeight}. ${notBids.length} other seal payments were not counted (wrong deposit, late, repeated or malformed) and are owed back in full.`,
      fromChain: [`${onTimeSeals} seals with the right deposit, on time`, ...notBids.map((x) => `not a bid ${short(x.txid)}: ${x.why}`)],
      fromDisclosure: [`deposit ${zat(sealedRules.depositZat)}`, `close height ${d.closeHeight}`]
    });
    const notOpened = [
      ...so.unopened.map((x) => ({ txid: x.txid, why: "was never opened in the window" })),
      ...so.badOpen.map((x) => ({ txid: x.txid, why: "was opened with a price that does not match its seal, or above the deposit" }))
    ];
    const countedWrong = notOpened.filter((x) => listedIds.has(x.txid));
    add({
      id: "seal-openings",
      level: 2,
      title: "Every counted bid has one matching opening",
      status: countedWrong.length ? "FAIL" : "PASS",
      reason: countedWrong.length ? `The seller counted ${countedWrong.length} seal(s) without a matching opening: ${countedWrong.map((x) => `${short(x.txid)} ${x.why}`).join("; ")}.` : `Each of the ${so.counted.length} counted bids has exactly one opening after block ${d.closeHeight} and up to block ${d.openByHeight} whose price matches its seal.`,
      fromChain: [`${so.counted.length} seals with a matching opening`, ...notOpened.map((x) => `not counted ${short(x.txid)}: ${x.why}`)],
      fromSeller: [`${r.bids.length} bids listed`],
      fromDisclosure: [`openings after block ${d.closeHeight}, up to block ${d.openByHeight}`]
    });
    const chainUnopened = [...so.unopened, ...so.badOpen].map((x) => x.txid);
    const said = new Set(r.unopened ?? []);
    const hidden = chainUnopened.filter((t) => !said.has(t));
    const invented = [...said].filter((t) => !chainUnopened.includes(t));
    const forfeitOk = hidden.length === 0 && invented.length === 0;
    const neverOpened = `${so.unopened.length} seals were never opened and ${so.badOpen.length} were opened with a price that does not match`;
    add({
      id: "seal-forfeits",
      level: 2,
      title: "Seals that paid the penalty are all reported",
      status: forfeitOk ? "PASS" : "FAIL",
      reason: forfeitOk ? `${neverOpened}. The seller reports the same ${chainUnopened.length}. ${so.penaltyTotal > 0 ? `Their penalties of ${zat(so.penaltyTotal)} were shared to the ${so.counted.length} counted bids.` : "No penalty was charged."}` : `${neverOpened}. ${hidden.length ? `Not reported by the seller: ${hidden.map(short).join(", ")}. ` : ""}${invented.length ? `Reported but not unopened on the chain: ${invented.map(short).join(", ")}.` : ""}`.trim(),
      fromChain: [`${so.unopened.length} seals never opened`, `${so.badOpen.length} badly opened`, `penalties ${zat(so.penaltyTotal)}`],
      fromSeller: [`${said.size} unopened seals reported`],
      fromDisclosure: [`penalty per seal ${zat(sealedRules.forfeitZat)}`]
    });
    return { seals: so.counted.length + so.unopened.length + so.badOpen.length, counted: so.counted.length, unopened: so.unopened.length, badlyOpened: so.badOpen.length };
  }
  return void 0;
}

// src/fetch/verify.ts
import { createRequire as createRequire2 } from "node:module";
var require3 = createRequire2(import.meta.url);
var decoder2 = require3("../vendor/decoder/imani_decoder.js");

// src/fetch/index.ts
var MAX_HEIGHT_SENTINEL = 2n ** 63n;

// src/scan/input.ts
function scanFromChain(d, chain, opts = {}) {
  const range = scanRange(d, opts.graceBlocks ?? DEFAULT_GRACE_BLOCKS);
  validateChainFile(chain);
  if (chain.network !== d.network) throw new ScanInputError(`Input error: the chain file is for the ${chain.network} network but the disclosure says ${d.network}.`);
  const started = Date.now();
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  let bytes = 0;
  for (const b of blocks) for (const t of b.txs) bytes += t.txHex.length / 2;
  const source = { kind: "chain-file", label: opts.label ?? "a saved block file (offline)", serversContacted: [], bytes, ms: Date.now() - started };
  return { blocks, missing, source, graceBlocks: range.graceBlocks, bidderKeys: opts.bidderKeys };
}

// src/relay/check-api.ts
var ROUNDS = ["testnet-01"];
function examplesDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    const d = join(here, up, "examples");
    if (existsSync(d)) return d;
  }
  throw new Error("examples folder not found");
}
var readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function checkRound(round, dir = examplesDir()) {
  if (!ROUNDS.includes(round)) throw new RangeError("unknown round");
  const started = Date.now();
  const d = readJson(join(dir, round, "disclosure.json"));
  const r = readJson(join(dir, round, "result.json"));
  const chain = readJson(join(dir, round, "chain.json"));
  const scan = scanFromChain(d, chain, { label: `the saved blocks of examples/${round}` });
  const v = checkLot(d, r, { scan });
  const range = v.scanRange;
  return {
    round,
    verdict: v.result,
    checks: { passed: v.checks.filter((c) => c.status === "PASS").length, total: v.checks.length },
    failed: v.failed,
    network: v.network,
    lotId: v.lotId,
    blockRange: range ? { from: range.from, to: range.to, blocks: range.to - range.from + 1 } : null,
    source: { kind: scan.source.kind, label: scan.source.label, serversContacted: scan.source.serversContacted },
    tookMs: Date.now() - started
  };
}
var HEADERS = { "cache-control": "public, max-age=60", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "access-control-allow-origin": "*" };
var esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function badgeSvg(a) {
  const pass = a.verdict === "PASS";
  const right = pass ? `PASS ${a.checks.passed}/${a.checks.total}` : `FAIL ${a.failed.length} of ${a.checks.total}`;
  const label = "Imani verified fair";
  const lw = 132;
  const rw = Math.max(72, 14 + right.length * 7);
  const alt = pass ? `Imani: ${a.round} checked fair, ${a.checks.passed} of ${a.checks.total} checks passed` : `Imani: ${a.round} failed ${a.failed.length} checks`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="24" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title><rect width="${lw}" height="24" fill="#1b2330"/><rect x="${lw}" width="${rw}" height="24" fill="${pass ? "#1a6b3a" : "#a32020"}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="12" text-anchor="middle"><text x="${lw / 2}" y="16">${label}</text><text x="${lw + rw / 2}" y="16" font-weight="bold">${esc(right)}</text></g></svg>`;
}
function checkApi(dir) {
  const kept = /* @__PURE__ */ new Map();
  return (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "Only GET" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const keys = [...url.searchParams.keys()];
    const round = url.searchParams.get("round");
    const format = url.searchParams.get("format");
    if (!round || keys.some((k) => k !== "round" && k !== "format") || format !== null && format !== "svg") return send(400, { error: "Give ?round=<name> (and optionally &format=svg)", rounds: ROUNDS });
    if (!ROUNDS.includes(round)) return send(404, { error: "unknown round", rounds: ROUNDS });
    try {
      if (!kept.has(round)) kept.set(round, checkRound(round, dir));
      if (format === "svg") {
        res.writeHead(200, { ...HEADERS, "content-type": "image/svg+xml; charset=utf-8" });
        return void res.end(badgeSvg(kept.get(round)));
      }
      send(200, kept.get(round));
    } catch {
      send(500, { error: "could not check this round" });
    }
  };
}

// src/relay/check-vercel.ts
var check_vercel_default = checkApi();
export {
  check_vercel_default as default
};
