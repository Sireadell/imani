import type { ChallengeStore, StoredChallenge } from "./challenge.ts";

/** Something the site must never hold, with the label shown on the receipt. The value is never printed. */
export interface ReceiptProbe {
  label: string;
  value: string;
}

/** Extra data the site's own code keeps for the visitor, for example the session cookie value. */
export interface HeldValue {
  where: string;
  /** The real value, searched for leaks. */
  text: string;
  /** What the receipt shows instead, when the real value should not be displayed (a session cookie). */
  show?: string;
}

export interface ReceiptField {
  where: string;
  field: string;
  value: string;
}

export interface Receipt {
  siteId: string;
  accountId: string;
  /** Every value the site holds that belongs to this account, read from what the site actually stores. */
  stored: ReceiptField[];
  /** What the site holds that is not tied to any account (the list of used transactions). */
  shared: ReceiptField[];
  /** How many stored values were scanned, and for each probe how many of them contained it. */
  scanned: number;
  notStored: { label: string; found: number }[];
}

/** What a store can report about itself. MemoryChallengeStore does; a database store adds the same method. */
export interface StoreDump {
  challenges: StoredChallenge[];
  txids: string[];
}

export function dumpOf(store: ChallengeStore): StoreDump | undefined {
  const d = (store as { dump?: () => StoreDump }).dump;
  return typeof d === "function" ? d.call(store) : undefined;
}

/**
 * Build the "what this site learned" receipt from the site's real storage, not from a hand-written list.
 * Every code the site made for this account, and every session value passed in, is listed. Then every
 * stored value is searched for each probe (the visitor's account key, the login memo, the wallet
 * address, the site's own viewing key) and the count is reported. The probe values are never printed.
 */
export function buildReceipt(opts: {
  siteId: string;
  accountId: string;
  store: ChallengeStore;
  held?: HeldValue[];
  probes?: ReceiptProbe[];
}): Receipt {
  const dump = dumpOf(opts.store);
  if (!dump) throw new Error("This store cannot list what it holds. Add a dump() method to build a receipt.");
  const stored: ReceiptField[] = [];
  const scanTexts: string[] = [];

  const mine = dump.challenges.filter((c) => c.accountId === opts.accountId);
  mine.forEach((c, i) => {
    const where = `login code record ${i + 1}`;
    const rows: [string, string][] = [
      ["account id", c.accountId ?? ""],
      ["one-time code", c.nonce],
      ["site", c.siteId],
      ["network", c.network],
      ["expires at", String(c.expiresAt)],
      ["smallest payment (zatoshis)", String(c.minZat)],
      ["receiving address of the site", c.siteAddress],
      ["used", c.used ? "yes" : "no"],
    ];
    for (const [field, value] of rows) stored.push({ where, field, value });
  });
  for (const h of opts.held ?? []) stored.push({ where: h.where, field: "contents", value: h.show ?? h.text });

  // Scan the whole store, not only this account's records, so a leak into another record still shows.
  for (const c of dump.challenges) scanTexts.push(JSON.stringify(c));
  for (const t of dump.txids) scanTexts.push(t);
  for (const h of opts.held ?? []) scanTexts.push(h.text);

  const notStored = (opts.probes ?? []).map((p) => ({
    label: p.label,
    found: p.value ? scanTexts.filter((t) => t.includes(p.value)).length : 0,
  }));
  const shared: ReceiptField[] = [{ where: "used transaction list", field: "transaction ids seen", value: String(dump.txids.length) }];

  return { siteId: opts.siteId, accountId: opts.accountId, stored, shared, scanned: scanTexts.length, notStored };
}

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s);

/** Plain-text receipt, the same words in tests, the terminal and the web pages. */
export function receiptText(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`${r.siteId} learned: account ${r.accountId.slice(0, 6)}`);
  lines.push("");
  lines.push("What this site stored for your account:");
  if (r.stored.length === 0) lines.push("  nothing");
  for (const f of r.stored) lines.push(`  ${f.where}: ${f.field} = ${short(f.value)}`);
  lines.push("");
  lines.push("Kept for all accounts together, not tied to you:");
  for (const f of r.shared) lines.push(`  ${f.field}: ${f.value}`);
  lines.push("");
  lines.push(`Searched ${r.scanned} stored values for things the site must not hold:`);
  for (const n of r.notStored) lines.push(`  ${n.label}: found in ${n.found}`);
  return lines.join("\n");
}

export function receiptClean(r: Receipt): boolean {
  return r.notStored.every((n) => n.found === 0);
}
