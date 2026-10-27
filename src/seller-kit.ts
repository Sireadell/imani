// The seller kit. `imani lot-new` sets up the files for a lot, `imani settle` makes the two files the
// seller publishes after the round and checks them. See docs/SELLER_KIT.md.
//
// The lot needs a fresh wallet account made for this one lot: its viewing key and its address. Imani does
// not make wallet keys (it only reads with them), so the seller makes the account in their wallet and gives
// Imani the read-only viewing key and the address.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertViewingKey, checkLot, InputError, type Verdict } from "./check.ts";
import type { Disclosure, PricingRule, SellerResult } from "./files.ts";
import { parseAddress } from "./read.ts";
import type { BlockSource, ChainBlock } from "./scan/chain.ts";
import { refereeRound, networkOfKey, type RefereeRound } from "./site/referee.ts";

export const LOT_PUBLIC = "lot-public.json";
export const LOT_PRIVATE = "lot-private.json";

export interface LotNewInput {
  lotId: string;
  address: string;
  /** The lot's read-only viewing key. Refused if it is a spending key or a seed phrase. */
  ufvk: string;
  itemCount: number;
  reserveZat: number;
  pricing?: PricingRule;
  topUps?: boolean;
  openHeight: number;
  closeHeight: number;
  refundByHeight: number;
}

export interface LotNewFiles {
  publicFile: Record<string, unknown>;
  privateFile: Record<string, unknown>;
  checklist: string;
}

const whole = (n: unknown, min: number) => typeof n === "number" && Number.isSafeInteger(n) && n >= min;

export function planLot(i: LotNewInput): LotNewFiles {
  const bad = (m: string): never => {
    throw new InputError(`Input error: ${m}`);
  };
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(i.lotId)) bad("the lot name must be 1 to 40 letters, digits, dots, dashes or underscores.");
  if (!whole(i.itemCount, 1)) bad("the number of items must be a whole number, 1 or more.");
  if (!whole(i.reserveZat, 0)) bad("the reserve must be a whole number of zatoshis, 0 or more.");
  if (i.pricing !== undefined && i.pricing !== "highest-losing" && i.pricing !== "lowest-winning") bad('the price rule must be "highest-losing" or "lowest-winning".');
  if (!whole(i.openHeight, 1) || !whole(i.closeHeight, 1) || !whole(i.refundByHeight, 1)) bad("the open, close and refund deadline blocks must be whole numbers above 0.");
  if (!(i.openHeight < i.closeHeight && i.closeHeight < i.refundByHeight)) bad("the blocks must run in order: open, then close, then the refund deadline.");
  let addressNetwork: "main" | "test";
  try {
    addressNetwork = parseAddress(i.address.trim()).network;
  } catch {
    return bad("the lot address is not a shielded Zcash address (u1..., utest1... or a Sapling address).");
  }
  const network = networkOfKey(i.ufvk);
  const ufvk = assertViewingKey(i.ufvk, network);
  if (addressNetwork !== network) bad("the lot address and the viewing key are for different Zcash networks.");

  const rules = {
    itemCount: i.itemCount,
    reserveZat: i.reserveZat,
    ...(i.pricing && i.pricing !== "highest-losing" ? { pricing: i.pricing } : {}),
    ...(i.topUps ? { topUps: true } : {}),
  };
  const publicFile = {
    format: "imani-lot-public/1",
    lotId: i.lotId,
    network,
    openHeight: i.openHeight,
    closeHeight: i.closeHeight,
    refundByHeight: i.refundByHeight,
    lotAddress: i.address.trim(),
    reserveZat: i.reserveZat,
    itemCount: i.itemCount,
    ...(rules.pricing ? { pricing: rules.pricing } : {}),
    ...(rules.topUps ? { topUps: true } : {}),
  };
  const privateFile = { format: "imani-lot-private/1", lotId: i.lotId, network, ufvk, rules };
  return { publicFile, privateFile, checklist: checklistText(i, network) };
}

function checklistText(i: LotNewInput, network: string): string {
  const price = i.pricing === "lowest-winning" ? "the lowest bid that won" : "the highest bid that lost (never below the reserve)";
  return `# Checklist for lot ${i.lotId}

Rules: ${i.itemCount} item(s), reserve ${i.reserveZat} zatoshis, winners pay ${price}${i.topUps ? ", bidders may raise a bid by paying again with the same memo before the close" : ""}. Network: ${network}.
Blocks: bids open at ${i.openHeight}, close at ${i.closeHeight}, every refund is due by ${i.refundByHeight}.

## Before bidding opens
- [ ] The lot address and the viewing key come from a wallet account made only for this lot. Never reuse an account that has other payments, because the key you publish later shows every payment into it.
- [ ] The key is a read-only viewing key (it starts with uview1 or uviewtest1). The kit refused spending keys and seed phrases already. Keep ${LOT_PRIVATE} private until the lot closes.
- [ ] Send a small test payment of your own to the lot address with the memo shown by \`imani bid-link\`, and check your wallet shows it arriving. Then do not count it as a bid (use a different account, or tell the bidders).
- [ ] Publish ${LOT_PUBLIC} (it holds no key) where bidders can find it, with the lot address.
- [ ] Give each bidder a bid link: \`imani bid-link --lot ${i.lotId} --address <lot address> --amount-zat <their bid>\`.

## While it runs
- [ ] Do not read the bids until the close. Anyone with the key can read them, including you.
- [ ] Do not spend from the lot account before the close.

## After the close (block ${i.closeHeight})
- [ ] Wait until block ${i.closeHeight} has passed. Run \`imani settle --folder <this folder> --fetch\` (or \`--chain <file>\`). It reads up to the newest block, prints what each bidder is owed and writes the two files to publish. The refunds are not paid yet and the blocks up to the deadline do not exist yet, so a FAIL is expected at this point.
- [ ] Pay every refund from the lot account, one payment per bid, with the memo \`refund:${i.lotId}:<bid transaction id>\` shown for it.
- [ ] After block ${i.refundByHeight}, run \`imani settle --folder <this folder> --fetch\` again. It must say PASS.

## Publish
- [ ] Publish disclosure.json and result.json from the settle folder. The disclosure holds the viewing key, so anyone can check the round, and nothing more than what the key shows.
- [ ] Tell the bidders how to check: \`imani check --disclosure disclosure.json --result result.json --scan --fetch\`, or drop the files on the checker page.
`;
}

export function readLotFile(folder: string, name: string): any {
  let text: string;
  try {
    text = readFileSync(join(folder, name), "utf8");
  } catch {
    throw new InputError(`Input error: cannot read ${name} in ${folder}. Run imani lot-new first.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`Input error: ${name} is not valid JSON.`);
  }
}

export function writeLotFiles(folder: string, f: LotNewFiles): string[] {
  mkdirSync(folder, { recursive: true });
  const out: [string, string][] = [
    [LOT_PUBLIC, JSON.stringify(f.publicFile, null, 2) + "\n"],
    [LOT_PRIVATE, JSON.stringify(f.privateFile, null, 2) + "\n"],
    ["CHECKLIST.md", f.checklist],
  ];
  for (const [name] of out) {
    try {
      readFileSync(join(folder, name));
      throw new InputError(`Input error: ${name} already exists in ${folder}. Pick another folder, so nothing is overwritten.`);
    } catch (e) {
      if (e instanceof InputError) throw e;
    }
  }
  for (const [name, text] of out) writeFileSync(join(folder, name), text, { flag: "wx" });
  return out.map(([n]) => n);
}

export interface SettleInput {
  folder: string;
  blocks: ChainBlock[];
  missing: number[];
  source: BlockSource;
}

export interface Settlement {
  bidMemos: Record<string, string>;
  disclosure: Disclosure;
  result: SellerResult;
  verdict: Verdict;
  round: RefereeRound;
}

/** The block range a settlement reads: from the open block to the refund deadline. */
export function settleRange(folder: string): { network: "main" | "test"; from: number; to: number; closeHeight: number } {
  const pub = readLotFile(folder, LOT_PUBLIC);
  if (!pub || pub.format !== "imani-lot-public/1") throw new InputError(`Input error: ${LOT_PUBLIC} is not a lot public file.`);
  return { network: pub.network, from: pub.openHeight, to: pub.refundByHeight, closeHeight: pub.closeHeight };
}

/**
 * Before the refund deadline the newest blocks do not exist yet. An early settle reads from the
 * open block to the newest block (`tip`) and passes every later block up to the deadline as
 * missing, so the check of the whole range still fails: an early result never says the refund
 * window is complete. Refuses before the close, when the bids are not final.
 */
export function earlyRange(range: { from: number; to: number; closeHeight: number }, tip: number): { to: number; missing: number[] } {
  if (tip >= range.to) return { to: range.to, missing: [] };
  if (tip < range.closeHeight) {
    throw new InputError(`Input error: the lot has not closed yet. The newest block is ${tip} and bids count up to block ${range.closeHeight}. Run settle again after block ${range.closeHeight}.`);
  }
  const missing: number[] = [];
  for (let h = tip + 1; h <= range.to; h++) missing.push(h);
  return { to: tip, missing };
}

/** Build the seller's two files from the chain, add the published totals and check the round. */
export function settle(i: SettleInput): Settlement {
  const pub = readLotFile(i.folder, LOT_PUBLIC);
  const priv = readLotFile(i.folder, LOT_PRIVATE);
  if (!pub || pub.format !== "imani-lot-public/1" || !priv || priv.format !== "imani-lot-private/1") throw new InputError("Input error: the lot files in this folder are not from imani lot-new.");
  if (pub.lotId !== priv.lotId) throw new InputError("Input error: the two lot files are for different lots.");
  const rules = priv.rules;
  const out = refereeRound({
    key: priv.ufvk,
    from: pub.openHeight,
    to: pub.refundByHeight,
    itemCount: rules.itemCount,
    reserveZat: rules.reserveZat,
    pricing: rules.pricing,
    topUps: rules.topUps === true,
    closeHeight: pub.closeHeight,
    lotId: pub.lotId,
    blocks: i.blocks,
    missing: i.missing,
    source: i.source,
  });
  if (!out.ok) throw new InputError(out.message);
  const { disclosure, result, payments, receivedZat } = out.files;
  const refunded = result.refunds.reduce((s, f) => s + f.amountZat, 0);
  result.totals = { payments, receivedZat, keptZat: receivedZat - refunded, refundedZat: refunded };
  const verdict = checkLot(disclosure, result, { scan: { blocks: i.blocks, missing: i.missing, source: i.source, graceBlocks: 0 } });
  return { disclosure, result, verdict, round: out.round, bidMemos: out.files.bidMemos };
}
