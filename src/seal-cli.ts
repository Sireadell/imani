// `imani seal` and `imani open`: make the two memos of a sealed bid. No network, no key.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoPrefix, parseOpenMemo, parseSealMemo, sealHash, sealMemoPrefix } from "./files.ts";

export interface SealCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const NONE = "Servers contacted: none";
export const SEAL_USAGE = `Usage: imani seal --lot <lot id> --amount <zat> [--address <your refund address>] [--deposit <zat>] [--out <folder>]
       imani open --file seal-<word>.json

  seal   prints the seal memo to put in your deposit payment, and saves seal-<word>.json with your price and salt.
         Keep that file private until the lot closes. Whoever holds it can open your seal.
  open   after the lot closes, prints the opening memo to send in a second small payment.
  --deposit  refuse a price above the lot's deposit.
Nothing here contacts a server or uses a key.`;

const VALUES = new Set(["--lot", "--amount", "--address", "--deposit", "--out", "--file", "--word", "--salt"]);

function options(args: string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!VALUES.has(a) || i + 1 >= args.length) return `Unknown or incomplete option ${a}.`;
    out[a.slice(2)] = args[++i];
  }
  return out;
}

const bad = (msg: string): SealCliResult => ({ code: 2, stdout: "", stderr: `${msg}\n${SEAL_USAGE}\n${NONE}` });

export function runSeal(args: string[]): SealCliResult {
  const o = options(args);
  if (typeof o === "string") return bad(o);
  if (!o.lot || !/^[A-Za-z0-9._-]{1,40}$/.test(o.lot)) return bad("--lot must be the lot id (1 to 40 letters, digits, dots, dashes or underscores).");
  if (!o.amount || !/^[1-9][0-9]{0,15}$/.test(o.amount)) return bad("--amount must be a whole number of zatoshis above 0, with no leading zeros.");
  const amount = Number(o.amount);
  if (!Number.isSafeInteger(amount)) return bad("--amount is too large.");
  if (o.deposit !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(o.deposit)) return bad("--deposit must be a whole number of zatoshis above 0.");
    if (amount > Number(o.deposit)) return bad(`Refused: the price ${amount} is higher than the lot's deposit ${o.deposit}. A bid can never be higher than the deposit.`);
  }
  if (o.address !== undefined && (o.address.trim() === "" || /[\s:]/.test(o.address))) return bad("--address must be one shielded address with no spaces or colons.");
  const word = o.word ?? randomBytes(4).toString("hex").slice(0, 4).replace(/[^a-z0-9]/g, "x");
  const salt = o.salt ?? randomBytes(16).toString("hex");
  const address = o.address?.trim() || null;
  const hash = sealHash(o.lot, word, amount, salt, address);
  const memo = `${sealMemoPrefix(o.lot)}${word}:${hash}${address ? `:${address}` : ""}`;
  if (!parseSealMemo(o.lot, memo)) return bad("The word or salt given does not make a well-formed seal.");
  const file = join(o.out ?? ".", `seal-${word}.json`);
  const record = { format: "imani-seal-file/1", lotId: o.lot, word, amountZat: amount, salt, address, sealMemo: memo };
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch {
    return bad(`Cannot write ${file}. Pick another folder with --out, or move the existing file.`);
  }
  return {
    code: 0,
    stdout: [
      `Seal memo for lot ${o.lot}. Put exactly this in the memo of your deposit payment:`,
      "",
      memo,
      "",
      `Saved ${file}. It holds your price and your salt. Keep it private until the lot closes, then run: imani open --file ${file}`,
      NONE,
    ].join("\n"),
    stderr: "",
  };
}

export function runOpen(args: string[]): SealCliResult {
  const o = options(args);
  if (typeof o === "string") return bad(o);
  if (!o.file) return bad("--file must be the seal file made by imani seal.");
  let rec: any;
  try {
    rec = JSON.parse(readFileSync(o.file, "utf8"));
  } catch {
    return bad(`Cannot read ${o.file} as a seal file.`);
  }
  if (!rec || rec.format !== "imani-seal-file/1" || typeof rec.lotId !== "string" || typeof rec.word !== "string" || typeof rec.salt !== "string" || !Number.isSafeInteger(rec.amountZat)) {
    return bad(`${o.file} is not a seal file made by imani seal.`);
  }
  if (sealHash(rec.lotId, rec.word, rec.amountZat, rec.salt, rec.address ?? null) !== parseSealMemo(rec.lotId, String(rec.sealMemo))?.hash) {
    return bad(`${o.file} does not match its own seal memo. Do not open it.`);
  }
  const memo = `${openMemoPrefix(rec.lotId)}${rec.word}:${rec.amountZat}:${rec.salt}`;
  if (!parseOpenMemo(rec.lotId, memo)) return bad(`${o.file} does not make a well-formed opening.`);
  return {
    code: 0,
    stdout: [
      `Opening memo for lot ${rec.lotId}. Send any small payment to the lot address with exactly this memo, after the lot closes and before the opening deadline:`,
      "",
      memo,
      "",
      NONE,
    ].join("\n"),
    stderr: "",
  };
}
