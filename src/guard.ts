// Leak guard. Used before anything is printed or written, so a key or seed phrase can never
// leave the checker in a report, a verdict file or a memo.

const B32 = "[02-9ac-hj-np-z]";

/** Read-only viewing keys (unified, and the older sapling and orchard forms). */
export const VIEWING_KEY_RE = new RegExp(`(?:uviewtest|uview|uivktest|uivk|zxviewtestsapling|zxviews|zxview|zivk)1${B32}{40,}`);
/** Spending keys: anything that can move money. */
export const SPENDING_KEY_RE = new RegExp(
  String.raw`(?:secret-extended-key-(?:main|test)|zxsk|zxtestsk|zsk|usk|uskt)1${B32}{40,}|\b[xt]prv[1-9A-HJ-NP-Za-km-z]{50,}\b`,
);
/**
 * A seed phrase is a run of 12 or more plain lowercase words (3 to 8 letters). Ordinary sentences
 * are told apart because they contain common English words that no seed list holds (the, and,
 * from, with...), which break the run.
 */
const NOT_SEED_WORDS = new Set(["the", "and", "from", "with", "that", "this", "for", "are", "was", "not", "you", "your", "its", "into", "when", "then", "there", "have", "will", "can", "all", "any", "but", "has", "had", "does", "than"]);
export function looksLikeSeedPhrase(text: string): boolean {
  for (const seg of text.split(/[\n\r"'`:=,;.<>()\[\]{}|]/)) {
    let run = 0;
    for (const w of seg.split(/ +/)) {
      run = /^[a-z]{3,8}$/.test(w) && !NOT_SEED_WORDS.has(w) ? run + 1 : 0;
      if (run >= 12) return true;
    }
  }
  return false;
}

export type SecretKind = "viewing key" | "spending key" | "seed phrase";

/** Name the first secret-shaped thing in the text, or null. Never returns the secret itself. */
export function findSecret(text: string): SecretKind | null {
  if (SPENDING_KEY_RE.test(text)) return "spending key";
  if (VIEWING_KEY_RE.test(text)) return "viewing key";
  if (looksLikeSeedPhrase(text)) return "seed phrase";
  return null;
}

export class LeakGuardError extends Error {}

/** Throw a named error when the text holds something shaped like a key or seed phrase. The message never repeats it. */
export function assertNoSecret(text: string, where: string): void {
  const kind = findSecret(text);
  if (kind) {
    throw new LeakGuardError(`Blocked: ${where} would contain something shaped like a ${kind}. Nothing was written. Keys and seed phrases are never put in memos, reports or output files.`);
  }
}

const ADDRESS_RES = [
  new RegExp(String.raw`\b(?:utest|u|ztestsapling|zs)1${B32}{30,}`, "g"),
  /\bt[13m][1-9A-HJ-NP-Za-km-z]{33}\b/g,
];
const AMOUNT_RES = [/\b\d{1,3}(?:,\d{3})+(?:\s*zat)?/g, /\b\d+\s*zat\b/gi, /\b\d+\.\d{1,8}\s*ZEC\b/g];

/** Discreet mode, last line of defence: hide addresses and amounts in any text. */
export function maskDiscreet(text: string): string {
  let out = text;
  for (const re of ADDRESS_RES) out = out.replace(re, "[address hidden]");
  for (const re of AMOUNT_RES) out = out.replace(re, "[hidden]");
  return out;
}
