import { createHash } from "node:crypto";
import * as reader from "../read.ts";
import type { ReadOutput } from "../read.ts";
import { networkOfViewingKey, type ChallengeStore, type Network } from "./challenge.ts";
import { MEMO_TAG, parseLoginMemo, proofText, signedText, type LoginMemo } from "./memo.ts";
import { verifySignature } from "./key.ts";

/** Every way a login can be refused. Each has one plain message that never repeats private data. */
export const FAILURES = {
  bad_viewing_key: "The site's viewing key is not a unified full viewing key (uview1 or uviewtest1).",
  unreadable_transaction: "The transaction could not be read.",
  nothing_for_this_site: "This transaction pays nothing to this site.",
  no_login_memo: "The payment to this site has no login memo.",
  several_login_memos: "The transaction carries more than one login memo for this site.",
  not_a_login_memo: "The memo is not an imani login memo (version 1).",
  memo_malformed: "The login memo is damaged or cut off.",
  memo_too_long: "The memo is longer than 512 bytes.",
  wrong_site: "The login memo was made for a different site.",
  wrong_network: "The login memo was made for the other Zcash network.",
  code_expired: "The login code has expired. Ask the site for a new one.",
  bad_signature: "The login memo's signature does not match its account key.",
  bad_proof: "The login proof is missing or does not match the memo's account key.",
  wrong_account: "This login code was reserved for a different account key.",
  unknown_code: "This site never issued that login code.",
  code_already_used: "That login code was already used.",
  code_mismatch: "The login memo does not match the code the site issued.",
  wrong_address: "The login code was issued for a different receiving address.",
  amount_too_low: "The login payment is below the site's minimum.",
  transaction_already_used: "This transaction was already used for a login.",
} as const;

export type FailureReason = keyof typeof FAILURES;
export type Failure = { ok: false; reason: FailureReason; message: string };

function fail(reason: FailureReason): Failure {
  return { ok: false, reason, message: FAILURES[reason] };
}

export interface MemoContext {
  siteId: string;
  network: Network;
  /** Current time in seconds. */
  now: number;
}

/**
 * Check one login memo on its own, with no transaction and no store.
 * This is the part another implementation can test against docs/login/vectors.json.
 * Order: format, site, network, expiry, signature.
 */
export function checkLoginMemo(memoText: string, ctx: MemoContext): { ok: true; memo: LoginMemo } | Failure {
  const parsed = parseLoginMemo(memoText);
  if (!parsed.ok) return fail(parsed.reason);
  const m = parsed.memo;
  if (m.siteId !== ctx.siteId) return fail("wrong_site");
  if (m.network !== ctx.network) return fail("wrong_network");
  if (ctx.now > m.expiresAt) return fail("code_expired");
  if (!verifySignature(m.accountId, signedText(m), m.signature)) return fail("bad_signature");
  return { ok: true, memo: m };
}

export type TxReader = (txHex: string, viewingKey: string) => { txid: string; outputs: ReadOutput[] };

/** Default reader: the repo's librustzcash decoder. The transaction id comes from the decoder when it gives one. */
const defaultReader: TxReader = (txHex, viewingKey) => {
  const withId = (reader as Record<string, unknown>).readTransactionWithId as TxReader | undefined;
  if (withId) return withId(txHex, viewingKey);
  return { txid: "sha256:" + createHash("sha256").update(txHex.toLowerCase()).digest("hex"), outputs: reader.readTransaction(txHex, viewingKey) };
};

export interface VerifyOptions {
  /** This site's id, the same one used in createChallenge. */
  siteId: string;
  /** This site's receiving address. If given, the code must have been issued for it. */
  siteAddress?: string;
  /** Clock override in seconds, for tests. */
  now?: number;
  /** Swap the transaction reader (tests, or a different decoder). */
  readTx?: TxReader;
  /**
   * The login proof from the user's page (buildLoginProof). Without a valid proof for the memo's
   * account key the login is refused, so a copied memo is worthless.
   */
  proof?: string;
  /** Optional event hook. It receives only event names such as "login_ok" or "login_failed:code_expired". */
  log?: (event: string) => void;
}

export interface LoginSuccess {
  ok: true;
  /** The account id to store: the user's per-site public key. */
  accountId: string;
  /** Everything this login told the site, for the "what this site learned" card. */
  siteLearned: { accountId: string; amountZat: number; pool: string };
}

/**
 * Check a login payment and, if it passes, use up its one-time code.
 * Inputs: the raw transaction (hex), the site's own read-only viewing key, and the code store.
 * Servers contacted: none. The caller supplies the transaction bytes.
 */
export async function verifyLoginPayment(txHex: string, siteUfvk: string, store: ChallengeStore, opts: VerifyOptions): Promise<LoginSuccess | Failure> {
  const result = await verifyInner(txHex, siteUfvk, store, opts);
  opts.log?.(result.ok ? "login_ok" : `login_failed:${result.reason}`);
  return result;
}

async function verifyInner(txHex: string, siteUfvk: string, store: ChallengeStore, opts: VerifyOptions): Promise<LoginSuccess | Failure> {
  const network = networkOfViewingKey(siteUfvk);
  if (!network) return fail("bad_viewing_key");
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  let tx: { txid: string; outputs: ReadOutput[] };
  try {
    if (typeof txHex !== "string" || !/^([0-9a-fA-F]{2})+$/.test(txHex)) return fail("unreadable_transaction");
    tx = (opts.readTx ?? defaultReader)(txHex, siteUfvk);
  } catch {
    return fail("unreadable_transaction");
  }
  const incoming = tx.outputs.filter((o) => o.transferType === "incoming");
  if (incoming.length === 0) return fail("nothing_for_this_site");
  const logins = incoming.filter((o) => o.memo.startsWith(MEMO_TAG + "\n") || o.memo.replace(/\u0000+$/, "") === MEMO_TAG);
  if (logins.length === 0) return fail("no_login_memo");
  if (logins.length > 1) return fail("several_login_memos");
  const output = logins[0];

  const checked = checkLoginMemo(output.memo, { siteId: opts.siteId, network, now });
  if (!checked.ok) return checked;
  const m = checked.memo;

  // The submitter must hold the account key. This runs before anything is recorded or used up, so a
  // stranger who submits someone else's payment (the transaction bytes are public) burns nothing.
  if (typeof opts.proof !== "string" || !verifySignature(m.accountId, proofText(m.siteId, m.nonce), opts.proof)) {
    return fail("bad_proof");
  }

  // One transaction, one look. A copied transaction is refused even if its code is somehow still open.
  if (!(await store.markTransactionUsed(tx.txid))) return fail("transaction_already_used");

  const challenge = await store.get(m.nonce);
  if (!challenge) return fail("unknown_code");
  if (challenge.used) return fail("code_already_used");
  if (challenge.accountId !== undefined && challenge.accountId !== m.accountId) return fail("wrong_account");
  if (challenge.siteId !== m.siteId) return fail("wrong_site");
  if (challenge.network !== m.network) return fail("wrong_network");
  if (challenge.expiresAt !== m.expiresAt) return fail("code_mismatch");
  if (now > challenge.expiresAt) return fail("code_expired");
  if (opts.siteAddress !== undefined && challenge.siteAddress !== opts.siteAddress) return fail("wrong_address");
  if (output.amountZat < challenge.minZat) return fail("amount_too_low");
  if (!(await store.consume(m.nonce))) return fail("code_already_used");

  return { ok: true, accountId: m.accountId, siteLearned: { accountId: m.accountId, amountZat: output.amountZat, pool: output.pool } };
}
