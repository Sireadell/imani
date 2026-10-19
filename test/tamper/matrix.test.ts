// Tamper matrix: every way a seller could change one fact in the published files, applied to
// every honest example round, one change at a time.
//
// Locked answers (fixed 2026-10-19, before the first run, and must not move):
//   1. Each honest round, as shipped, gives PASS.
//   2. Every change in FACT_CHANGES gives anything but PASS: a FAIL, or a refusal to read the files.
//   3. Every change in SAME_FACTS (order of lists, order of fields) gives the same result and
//      the same failed checks as the untouched round.
//   4. Running a round twice gives the same verdict, word for word.
//   5. With --discreet, no bid amount, refund amount or memo of the round appears anywhere in
//      the verdict.
//
// Correction 2026-10-19, after the first run: answer 2 also listed "bytes changed in the middle"
// of each transaction. The middle of these transactions is proof and signature data, which the
// transaction id does not cover (ZIP 244), so the payment facts there are not changed. Those
// changes moved to SIGNATURE_DATA below, locked to the answer the first run showed it needs:
// the transaction id read from the bytes stays the same and the verdict stays the same.
// The same run found one real gap, now fixed in src/check.ts: a refund for a late bid that was
// left out of the disclosure passed at the key level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLot, type Verdict } from "../../src/check.ts";
import { readTransactionWithId } from "../../src/read.ts";
import { blocksInRange } from "../../src/scan/chain.ts";
import { DEFAULT_GRACE_BLOCKS, scanRange, type ScanInput } from "../../src/scan/scan.ts";

const ex = (p: string) => JSON.parse(readFileSync(new URL(`../../examples/${p}`, import.meta.url), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

type Files = { d: any; r: any; chain?: any };
const ROUNDS: Record<string, Files> = {
  "round-01": { d: ex("round-01/disclosure.json"), r: ex("round-01/result.json") },
  "memo-01": { d: ex("memo-01/disclosure.json"), r: ex("memo-01/result.json") },
  "receivers-01": { d: ex("receivers-01/disclosure.json"), r: ex("receivers-01/result.json") },
  "scan-01": { d: ex("scan-01/disclosure.json"), r: ex("scan-01/result.json"), chain: ex("scan-01/chain.json") },
  "testnet-01": { d: ex("testnet-01/disclosure.json"), r: ex("testnet-01/result.json"), chain: ex("testnet-01/chain.json") },
  "sealed-01": { d: ex("sealed-01/disclosure.json"), r: ex("sealed-01/result.json") },
};

function scanOf(d: any, chain: any): ScanInput | undefined {
  if (!chain) return undefined;
  const range = scanRange(d, DEFAULT_GRACE_BLOCKS);
  const { blocks, missing } = blocksInRange(chain, range.from, range.to);
  return { blocks, missing, source: { kind: "chain-file", label: "the chain file (offline)", serversContacted: [], bytes: 0, ms: 0 }, graceBlocks: range.graceBlocks };
}

type Outcome = { result: "PASS" | "FAIL" | "refused"; failed: string[]; verdict?: Verdict };
function judge(f: Files, discreet = false): Outcome {
  try {
    const v = checkLot(clone(f.d), clone(f.r), { scan: scanOf(f.d, f.chain), discreet });
    return { result: v.result, failed: v.failed, verdict: v };
  } catch {
    return { result: "refused", failed: [] };
  }
}

const flipHex = (h: string, at: number) => h.slice(0, at) + (h[at] === "0" ? "1" : "0") + h.slice(at + 1);
const OTHER_TXID = "ab".repeat(32);

type Change = { name: string; apply: (f: Files) => void };

/** One change of fact per entry. Built from the round, so every bid, refund and transaction gets its own. */
function factChanges(f: Files): Change[] {
  const out: Change[] = [];
  const add = (name: string, apply: (f: Files) => void) => out.push({ name, apply });
  const r = f.r;
  const d = f.d;

  // Seller's result file.
  r.bids.forEach((_: any, i: number) => {
    add(`result: bid ${i + 1} amount one zatoshi higher`, (x) => { x.r.bids[i].amountZat += 1; });
    add(`result: bid ${i + 1} amount one zatoshi lower`, (x) => { x.r.bids[i].amountZat -= 1; });
    add(`result: bid ${i + 1} amount doubled`, (x) => { x.r.bids[i].amountZat *= 2; });
    add(`result: bid ${i + 1} left out`, (x) => { x.r.bids.splice(i, 1); });
    add(`result: bid ${i + 1} left out and the count lowered to match`, (x) => { x.r.bids.splice(i, 1); x.r.bidCount -= 1; });
    add(`result: bid ${i + 1} id changed`, (x) => { x.r.bids[i].txid = flipHex(x.r.bids[i].txid, 7); });
    add(`result: bid ${i + 1} listed twice`, (x) => { x.r.bids.push(clone(x.r.bids[i])); x.r.bidCount += 1; });
  });
  add("result: bid count one higher", (x) => { x.r.bidCount += 1; });
  add("result: bid count one lower", (x) => { x.r.bidCount -= 1; });
  add("result: a made-up bid added", (x) => { x.r.bids.push({ txid: OTHER_TXID, amountZat: 9_000_000 }); x.r.bidCount += 1; });
  add("result: clearing price one zatoshi higher", (x) => { x.r.clearingPriceZat += 1; });
  add("result: clearing price one zatoshi lower", (x) => { x.r.clearingPriceZat -= 1; });
  add("result: clearing price set to zero", (x) => { x.r.clearingPriceZat = 0; });
  add("result: reserve outcome flipped", (x) => { x.r.reserveMet = !x.r.reserveMet; });
  add("result: item count one higher", (x) => { x.r.rules.itemCount += 1; });
  add("result: reserve one zatoshi higher", (x) => { x.r.rules.reserveZat += 1; });
  add("result: lot id changed", (x) => { x.r.lotId = `${x.r.lotId}X`; });
  r.winners.forEach((_: any, i: number) => {
    add(`result: winner ${i + 1} dropped`, (x) => { x.r.winners.splice(i, 1); });
  });
  const losers = r.bids.map((b: any) => b.txid).filter((t: string) => !r.winners.includes(t));
  losers.forEach((t: string, i: number) => {
    add(`result: loser ${i + 1} named a winner as well`, (x) => { x.r.winners.push(t); });
    add(`result: loser ${i + 1} swapped in for winner 1`, (x) => { x.r.winners[0] = t; });
  });
  add("result: a made-up winner added", (x) => { x.r.winners.push(OTHER_TXID); });
  r.refunds.forEach((_: any, i: number) => {
    add(`result: refund ${i + 1} one zatoshi higher`, (x) => { x.r.refunds[i].amountZat += 1; });
    add(`result: refund ${i + 1} one zatoshi lower`, (x) => { x.r.refunds[i].amountZat -= 1; });
    add(`result: refund ${i + 1} left out`, (x) => { x.r.refunds.splice(i, 1); });
    add(`result: refund ${i + 1} listed twice`, (x) => { x.r.refunds.push(clone(x.r.refunds[i])); });
    add(`result: refund ${i + 1} credited to a made-up bid`, (x) => { x.r.refunds[i].bidTxid = OTHER_TXID; });
  });

  // Seller's disclosure file.
  d.transactions.forEach((t: any, i: number) => {
    add(`disclosure: transaction ${i + 1} left out`, (x) => { x.d.transactions.splice(i, 1); });
    add(`disclosure: transaction ${i + 1} listed twice`, (x) => { x.d.transactions.push(clone(x.d.transactions[i])); });
    add(`disclosure: transaction ${i + 1} id changed`, (x) => { x.d.transactions[i].txid = flipHex(x.d.transactions[i].txid, 11); });
    add(`disclosure: transaction ${i + 1} bytes cut short`, (x) => { x.d.transactions[i].txHex = x.d.transactions[i].txHex.slice(0, -64); });
    add(`disclosure: transaction ${i + 1} swapped for the bytes of another`, (x) => { const j = (i + 1) % x.d.transactions.length; x.d.transactions[i].txHex = x.d.transactions[j].txHex; });
    if (r.bids.some((b: any) => b.txid === t.txid)) {
      add(`disclosure: bid transaction ${i + 1} moved past the close`, (x) => { x.d.transactions[i].height = x.d.closeHeight + 1; });
    }
  });
  add("disclosure: close moved before the first bid", (x) => { x.d.closeHeight = Math.min(...x.d.transactions.map((t: any) => t.height)) - 1; });
  add("disclosure: item count one higher", (x) => { x.d.rules.itemCount += 1; });
  add("disclosure: item count one lower", (x) => { x.d.rules.itemCount -= 1; });
  add("disclosure: reserve above the clearing price", (x) => { x.d.rules.reserveZat = x.r.clearingPriceZat + 1; });
  add("disclosure: lot id changed", (x) => { x.d.lotId = `${x.d.lotId}X`; });
  add("disclosure: lot key swapped for another lot's key", (x) => { x.d.ufvk = ROUNDS["testnet-01"].d.ufvk !== x.d.ufvk ? ROUNDS["testnet-01"].d.ufvk : ROUNDS["round-01"].d.ufvk; });
  add("disclosure: network changed", (x) => { x.d.network = x.d.network === "test" ? "main" : "test"; });
  if (d.refundAddresses) {
    d.refundAddresses.forEach((_: any, i: number) => {
      add(`disclosure: refund address ${i + 1} swapped with the next`, (x) => {
        const a = x.d.refundAddresses; const j = (i + 1) % a.length;
        [a[i].address, a[j].address] = [a[j].address, a[i].address];
      });
      add(`disclosure: refund address ${i + 1} left out`, (x) => { x.d.refundAddresses.splice(i, 1); });
    });
  }

  // Sealed lots: the new facts. Deposit, penalty, opening deadline, the unopened list and each opening's block.
  if (d.rules.kind === "sealed") {
    add("disclosure: deposit one zatoshi higher", (x) => { x.d.rules.depositZat += 1; });
    add("disclosure: deposit one zatoshi lower", (x) => { x.d.rules.depositZat -= 1; });
    add("disclosure: penalty one zatoshi higher", (x) => { x.d.rules.forfeitZat += 1; });
    add("disclosure: penalty one zatoshi lower", (x) => { x.d.rules.forfeitZat -= 1; });
    add("disclosure: penalty set to zero", (x) => { x.d.rules.forfeitZat = 0; });
    add("disclosure: opening deadline moved before the first opening", (x) => { x.d.openByHeight = x.d.closeHeight + 1; });
    add("disclosure: opening deadline removed", (x) => { delete x.d.openByHeight; });
    add("result: deposit one zatoshi higher", (x) => { x.r.rules.depositZat += 1; });
    add("result: penalty one zatoshi lower", (x) => { x.r.rules.forfeitZat -= 1; });
    add("result: unopened list emptied", (x) => { x.r.unopened = []; });
    add("result: unopened list removed", (x) => { delete x.r.unopened; });
    add("result: a made-up unopened seal added", (x) => { x.r.unopened.push(OTHER_TXID); });
    (r.unopened as string[]).forEach((_: string, i: number) => {
      add(`result: unopened seal ${i + 1} left out`, (x) => { x.r.unopened.splice(i, 1); });
      add(`result: unopened seal ${i + 1} id changed`, (x) => { x.r.unopened[i] = flipHex(x.r.unopened[i], 5); });
      add(`result: unopened seal ${i + 1} counted as a bid too`, (x) => { x.r.bids.push({ txid: x.r.unopened[i], amountZat: 1_000_000 }); x.r.bidCount += 1; });
    });
    // The openings are the four payments 6 to 15 blocks after the close (the seals and refunds sit elsewhere).
    const openingIdx = d.transactions.map((t: any, i: number) => ({ t, i })).filter(({ t }: any) => t.height > d.closeHeight + 5 && t.height < d.closeHeight + 15);
    for (const { i } of openingIdx) {
      add(`disclosure: transaction ${i + 1} (an opening) moved to the close block`, (x) => { x.d.transactions[i].height = x.d.closeHeight; });
      add(`disclosure: transaction ${i + 1} (an opening) moved past the opening deadline`, (x) => { x.d.transactions[i].height = x.d.openByHeight + 1; });
    }
  }

  // The blocks, for rounds with a scan.
  if (f.chain) {
    const listed = new Set(d.transactions.map((t: any) => t.txid));
    const holding = f.chain.blocks.filter((b: any) => b.txs.some((t: any) => listed.has(t.txid ?? "")) || d.transactions.some((t: any) => t.height === b.height));
    for (const h of [...new Set(holding.map((b: any) => b.height))] as number[]) {
      add(`chain: block ${h} holding a listed payment is missing`, (x) => { x.chain.blocks = x.chain.blocks.filter((b: any) => b.height !== h); });
    }
    d.transactions.forEach((_: any, i: number) => {
      add(`disclosure: transaction ${i + 1} said to be one block later than it is`, (x) => { x.d.transactions[i].height += 1; });
    });
  }
  return out;
}

/** Changes that keep every fact the same. */
const SAME_FACTS: Change[] = [
  { name: "result: bids in reverse order", apply: (x) => x.r.bids.reverse() },
  { name: "result: winners in reverse order", apply: (x) => x.r.winners.reverse() },
  { name: "result: refunds in reverse order", apply: (x) => x.r.refunds.reverse() },
  { name: "disclosure: transactions in reverse order", apply: (x) => x.d.transactions.reverse() },
  { name: "result: fields in reverse order", apply: (x) => { x.r = Object.fromEntries(Object.entries(x.r).reverse()); } },
  { name: "disclosure: fields in reverse order", apply: (x) => { x.d = Object.fromEntries(Object.entries(x.d).reverse()); } },
];

function changed(f: Files, c: Change): Files {
  const x: Files = { d: clone(f.d), r: clone(f.r), chain: f.chain ? clone(f.chain) : undefined };
  c.apply(x);
  return x;
}

let total = 0;
for (const [id, f] of Object.entries(ROUNDS)) {
  const base = judge(f);

  test(`${id}: the honest round passes`, () => {
    assert.equal(base.result, "PASS", `failed: ${base.failed.join(", ")}`);
  });

  test(`${id}: two runs give the same verdict word for word`, () => {
    assert.deepEqual(judge(f).verdict, base.verdict);
  });

  test(`${id}: discreet mode shows no amount or memo`, () => {
    const text = JSON.stringify(judge(f, true).verdict);
    const amounts = [...f.r.bids.map((b: any) => b.amountZat), ...f.r.refunds.map((x: any) => x.amountZat)];
    for (const a of amounts) assert.ok(!text.includes(a.toLocaleString("en-US") + " zat"), `amount ${a} shown`);
    for (const x of f.r.refunds) assert.ok(!text.includes(x.memo), "refund memo shown");
  });

  for (const c of SAME_FACTS) {
    test(`${id}: ${c.name} changes nothing`, () => {
      const o = judge(changed(f, c));
      assert.equal(o.result, base.result);
      assert.deepEqual(o.failed, base.failed);
    });
  }

  f.d.transactions.forEach((t: any, i: number) => {
    test(`${id}: transaction ${i + 1} proof bytes changed keeps its id and the verdict`, () => {
      const x = changed(f, { name: "", apply: (y) => { const h = y.d.transactions[i].txHex; y.d.transactions[i].txHex = flipHex(h, Math.floor(h.length / 2)); } });
      assert.equal(readTransactionWithId(x.d.transactions[i].txHex, f.d.ufvk).txid, t.txid);
      const o = judge(x);
      assert.equal(o.result, base.result);
      assert.deepEqual(o.failed, base.failed);
    });
  });

  for (const c of factChanges(f)) {
    total++;
    test(`${id}: ${c.name} is caught`, () => {
      const o = judge(changed(f, c));
      assert.notEqual(o.result, "PASS");
    });
  }
}

test("the matrix holds at least 300 changes of fact", () => {
  assert.ok(total >= 300, `only ${total}`);
});
