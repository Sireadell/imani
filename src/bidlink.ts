// A bid as a Zcash payment request (ZIP 321), so any wallet that reads payment requests can place the
// bid by scanning a QR code or opening a link. This builds the link only. It never sends anything,
// never contacts a server and never uses a key.
import qrcode from "qrcode-generator";
import { bidMemoPrefix, bidMemoAddress } from "./files.ts";
import { parseAddress } from "./read.ts";

export class BidLinkError extends Error {}

export interface BidLinkInput {
  lotId: string;
  /** The lot's shielded address, as published by the seller. */
  address: string;
  amountZat: number;
  /** The bidder's own short code. Made at random when missing. */
  word?: string;
  /** Where the bidder wants any refund sent, written inside the bid memo so the seller cannot change it. */
  refundAddress?: string;
  /** A ready-made memo (for example a sealed lot's seal memo). Replaces the bid memo. */
  memo?: string;
}

export interface BidLink {
  memo: string;
  uri: string;
  amountZec: string;
  network: "main" | "test";
}

const WORD = /^[A-Za-z0-9]{1,32}$/;
const MAX_ZAT = 21_000_000 * 100_000_000;

/** Whole zatoshis as the decimal ZEC amount ZIP 321 wants: a period, at most 8 digits after it. */
export function zatToZec(zat: number): string {
  const whole = Math.floor(zat / 100_000_000);
  const frac = String(zat % 100_000_000).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "0.03" or "1" as whole zatoshis, without ever using floating point. Returns null when it is not an amount. */
export function zecToZat(text: string): number | null {
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) return null;
  const zat = Number(m[1]) * 100_000_000 + Number((m[2] ?? "").padEnd(8, "0"));
  return zat >= 1 && Number.isSafeInteger(zat) ? zat : null;
}

/** Base64url with the padding removed, as ZIP 321 wants for the memo parameter. */
export function memoParam(memo: string): string {
  const bytes = new TextEncoder().encode(memo);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomWord(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
}

export function makeBidLink(i: BidLinkInput): BidLink {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(i.lotId)) throw new BidLinkError("The lot name must be 1 to 40 letters, digits, dots, dashes or underscores.");
  if (!Number.isSafeInteger(i.amountZat) || i.amountZat < 1 || i.amountZat > MAX_ZAT) throw new BidLinkError("The amount must be a whole number of zatoshis above 0 (1 ZEC = 100,000,000 zatoshis).");
  let network: "main" | "test";
  try {
    network = parseAddress(i.address.trim()).network;
  } catch {
    throw new BidLinkError("The lot address is not a shielded Zcash address. A bid must go to a unified (u1... or utest1...) or Sapling address, because a memo cannot be sent to a transparent address.");
  }
  let memo: string;
  if (i.memo !== undefined) {
    memo = i.memo;
  } else {
    const word = i.word ?? randomWord();
    if (!WORD.test(word)) throw new BidLinkError("The bidder code must be 1 to 32 letters or digits.");
    if (i.refundAddress !== undefined) {
      const refund = i.refundAddress.trim();
      if (refund === "" || /[\s:]/.test(refund)) throw new BidLinkError("The refund address must be one address with no spaces or colons.");
      let refundNetwork: "main" | "test";
      try {
        refundNetwork = parseAddress(refund).network;
      } catch {
        throw new BidLinkError("The refund address is not a shielded Zcash address.");
      }
      if (refundNetwork !== network) throw new BidLinkError("The refund address is for a different Zcash network than the lot address.");
      memo = `${bidMemoPrefix(i.lotId)}${word}:${refund}`;
      if (bidMemoAddress(i.lotId, memo) !== refund) throw new BidLinkError("The refund address could not be written into the memo.");
    } else {
      memo = `${bidMemoPrefix(i.lotId)}${word}`;
    }
  }
  if (memo === "" || new TextEncoder().encode(memo).length > 512) throw new BidLinkError("The memo must be between 1 and 512 bytes.");
  const amountZec = zatToZec(i.amountZat);
  const uri = `zcash:${i.address.trim()}?amount=${amountZec}&memo=${memoParam(memo)}`;
  return { memo, uri, amountZec, network };
}

export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** The QR code as text, two rows per line, for a terminal. Dark modules print as blocks on a light quiet zone. */
export function qrText(text: string): string {
  const m = qrMatrix(text);
  const q = 2;
  const size = m.length + q * 2;
  const dark = (r: number, c: number) => r >= q && c >= q && r < q + m.length && c < q + m.length && m[r - q][c - q];
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < size && dark(r + 1, c);
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** The QR code as an SVG picture: black squares on white with a four square quiet zone. */
export function qrSvg(text: string, scale = 6): string {
  const m = qrMatrix(text);
  const q = 4;
  const size = m.length + q * 2;
  let path = "";
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r][c]) path += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" role="img" aria-label="QR code of the bid link" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>\n`;
}
