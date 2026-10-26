// `imani bid-link`: turn a bid into a Zcash payment request link and QR code. No network, no key.
import { writeFileSync } from "node:fs";
import { BidLinkError, makeBidLink, qrSvg, qrText } from "./bidlink.ts";

export interface BidLinkCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const NONE = "Servers contacted: none";
export const BIDLINK_USAGE = `Usage: imani bid-link --lot <lot id> --address <lot address> --amount-zat <zat> [options]

  Makes a Zcash payment request (ZIP 321) for your bid: a zcash: link and a QR code. A wallet that
  reads payment requests, scanned or opened, fills in the lot address, the amount and the bid memo.
  --word <code>            your own bid code (letters and digits). Made at random when missing.
                           Paying again with the same memo before the close raises your bid, when the lot allows top-ups.
  --refund-address <addr>  write your refund address into the bid memo, so the seller cannot choose it
  --memo <text>            use this exact memo instead (for example the memo of a sealed bid made by imani seal)
  --svg <file>             also save the QR code as a picture
Nothing here sends a payment, contacts a server or uses a key.`;

const VALUES = new Set(["--lot", "--address", "--amount-zat", "--word", "--refund-address", "--memo", "--svg"]);

export function runBidLink(args: string[]): BidLinkCliResult {
  const bad = (msg: string): BidLinkCliResult => ({ code: 2, stdout: "", stderr: `${msg}\n\n${BIDLINK_USAGE}\n${NONE}` });
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!VALUES.has(a) || i + 1 >= args.length) return bad(`Unknown or incomplete option ${a}.`);
    o[a.slice(2)] = args[++i];
  }
  if (!o.lot) return bad("--lot is needed: the lot name.");
  if (!o.address) return bad("--address is needed: the lot address the seller published.");
  if (!o["amount-zat"] || !/^[1-9][0-9]{0,16}$/.test(o["amount-zat"])) return bad("--amount-zat must be a whole number of zatoshis above 0, with no leading zeros.");
  try {
    const link = makeBidLink({
      lotId: o.lot,
      address: o.address,
      amountZat: Number(o["amount-zat"]),
      word: o.word,
      refundAddress: o["refund-address"],
      memo: o.memo,
    });
    if (o.svg) {
      try {
        writeFileSync(o.svg, qrSvg(link.uri), { flag: "wx" });
      } catch {
        return bad(`Cannot write ${o.svg}. Pick another file name, or remove the existing file.`);
      }
    }
    const lines = [
      `Bid link for lot ${o.lot} on the ${link.network === "main" ? "main" : "test"} network: ${link.amountZec} ZEC (${o["amount-zat"]} zatoshis).`,
      "",
      "Open this link in a Zcash wallet, or scan the code below:",
      "",
      link.uri,
      "",
      qrText(link.uri),
      "",
      `Memo the wallet will send (nothing else is needed): ${link.memo}`,
      "Keep the bid code in that memo if you may want to raise your bid, and check the amount and address in your wallet before you send.",
    ];
    if (o.svg) lines.push(`QR code picture saved to ${o.svg}.`);
    lines.push(NONE);
    return { code: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (e) {
    if (e instanceof BidLinkError) return bad(`Refused: ${e.message}`);
    throw e;
  }
}
