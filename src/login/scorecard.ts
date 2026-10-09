import { checkSinglePayee } from "./uri.ts";

/**
 * A login that pays a small shielded amount with a code in the memo, seen from the outside.
 * To score any such login, write one small adapter (about 30 lines) that says how to start a
 * login, pay it, submit it and move the clock. The scorecard then runs six checks against it.
 * It never looks inside the login's code, only at what a user and a copycat can do.
 */
export interface LoginUnderTest {
  /** Shown on the scorecard. */
  name: string;
  /** How long a code stays valid, in seconds. */
  ttlSeconds: number;
  /** A user starts a login. Returns an opaque handle and the payment link the wallet will open. */
  begin(user: string): Promise<{ handle: unknown; link: string }>;
  /** The user's wallet pays the link. Returns an opaque payment and the address that wallet paid from. */
  pay(handle: unknown, link: string, wallet: string): Promise<{ payment: unknown; walletAddress: string }>;
  /**
   * Submit the payment to the site. "owner" is the user who started the login. "copycat" is someone who only
   * saw the payment (its transaction bytes are public to anyone who watches the site) and does not hold the
   * user's secrets. `raw` is the site's reply, as text.
   */
  submit(handle: unknown, payment: unknown, by: "owner" | "copycat"): Promise<{ ok: boolean; account?: string; raw: string }>;
  /** Move the site's clock forward. */
  advance(seconds: number): void | Promise<void>;
  /** Secret values for this login that must never appear in the payment link (the account key, the login proof). */
  secrets(handle: unknown): string[];
  /** Everything the site stored, as text. Optional: without it the "sender stays hidden" check is skipped. */
  stored?(): Promise<string>;
}

export type CheckStatus = "PASS" | "FAIL" | "SKIPPED";

export interface ScoreLine {
  id: string;
  title: string;
  status: CheckStatus;
  /** One plain sentence saying what happened. Never contains a secret. */
  detail: string;
}

export interface Scorecard {
  name: string;
  passed: number;
  failed: number;
  skipped: number;
  lines: ScoreLine[];
}

const LINE_TITLES: Record<string, string> = {
  "one-time-code": "A login code works once",
  expiry: "An old code is refused",
  rotation: "A new wallet address keeps the same account",
  "link-secrets": "The payment link holds no secret and pays one address",
  "sender-hidden": "The site never learns the paying wallet's address",
  "copycat-refused": "Someone who only saw the payment cannot log in as the user",
};

const line = (id: string, status: CheckStatus, detail: string): ScoreLine => ({ id, title: LINE_TITLES[id], status, detail });

async function guarded(id: string, fn: () => Promise<ScoreLine>): Promise<ScoreLine> {
  try {
    return await fn();
  } catch {
    // A crash is a failed check, never a pass. The message is dropped so nothing from the login leaks into the card.
    return line(id, "FAIL", "The check could not run to the end: the login threw an error.");
  }
}

/** Run the six checks. Each check uses its own users, so the order does not matter. */
export async function runScorecard(t: LoginUnderTest): Promise<Scorecard> {
  const lines: ScoreLine[] = [];
  const wallets: string[] = [];
  const replies: string[] = [];
  const links: string[] = [];
  const note = (r: { raw: string }) => replies.push(r.raw);

  lines.push(
    await guarded("one-time-code", async () => {
      const a = await t.begin("replay-user");
      links.push(a.link);
      const p1 = await t.pay(a.handle, a.link, "wallet-A");
      wallets.push(p1.walletAddress);
      const first = await t.submit(a.handle, p1.payment, "owner");
      note(first);
      if (!first.ok) return line("one-time-code", "FAIL", "The first, honest login was refused, so the check could not run.");
      const again = await t.submit(a.handle, p1.payment, "owner");
      note(again);
      const p2 = await t.pay(a.handle, a.link, "wallet-A");
      wallets.push(p2.walletAddress);
      const second = await t.submit(a.handle, p2.payment, "owner");
      note(second);
      if (again.ok) return line("one-time-code", "FAIL", "The same payment logged in twice.");
      if (second.ok) return line("one-time-code", "FAIL", "A second payment with the same code logged in again.");
      return line("one-time-code", "PASS", "The same payment and a second payment with the same code were both refused.");
    }),
  );

  lines.push(
    await guarded("expiry", async () => {
      const a = await t.begin("expiry-user");
      links.push(a.link);
      const p = await t.pay(a.handle, a.link, "wallet-A");
      wallets.push(p.walletAddress);
      await t.advance(t.ttlSeconds + 1);
      const late = await t.submit(a.handle, p.payment, "owner");
      note(late);
      return late.ok ? line("expiry", "FAIL", `A payment submitted ${t.ttlSeconds + 1} seconds after the code was made still logged in.`) : line("expiry", "PASS", `A payment submitted ${t.ttlSeconds + 1} seconds after the code was made was refused.`);
    }),
  );

  lines.push(
    await guarded("rotation", async () => {
      const a = await t.begin("rotation-user");
      links.push(a.link);
      const pa = await t.pay(a.handle, a.link, "wallet-A");
      wallets.push(pa.walletAddress);
      const one = await t.submit(a.handle, pa.payment, "owner");
      note(one);
      const b = await t.begin("rotation-user");
      links.push(b.link);
      const pb = await t.pay(b.handle, b.link, "wallet-B");
      wallets.push(pb.walletAddress);
      const two = await t.submit(b.handle, pb.payment, "owner");
      note(two);
      const other = await t.begin("someone-else");
      links.push(other.link);
      const po = await t.pay(other.handle, other.link, "wallet-A");
      wallets.push(po.walletAddress);
      const three = await t.submit(other.handle, po.payment, "owner");
      note(three);
      if (!one.ok || !two.ok || !three.ok || !one.account || !two.account || !three.account) {
        return line("rotation", "FAIL", "An honest login was refused, so the check could not run.");
      }
      if (one.account !== two.account) return line("rotation", "FAIL", "Paying from a new wallet address created a different account.");
      if (three.account === one.account) return line("rotation", "FAIL", "A different person who paid from the same wallet landed in the same account.");
      return line("rotation", "PASS", "The same user got the same account from two wallet addresses, and a different user got a different account.");
    }),
  );

  lines.push(
    await guarded("link-secrets", async () => {
      const a = await t.begin("link-user");
      links.push(a.link);
      // Look in the link as written and in the memo it carries, which a wallet decodes and a watcher can read.
      const memo = (() => {
        try {
          const m = new URLSearchParams(a.link.slice(a.link.indexOf("?") + 1)).get("memo") ?? "";
          return Buffer.from(m, "base64url").toString("utf8");
        } catch {
          return "";
        }
      })();
      const hits = t.secrets(a.handle).filter((s) => s && (a.link.includes(s) || memo.includes(s))).length;
      if (hits > 0) return line("link-secrets", "FAIL", `The payment link contains ${hits} value${hits === 1 ? "" : "s"} that should stay on the user's device.`);
      const payee = checkSinglePayee(a.link);
      if (!payee.ok) return line("link-secrets", "FAIL", `The payment link is not safe to open: ${payee.reason}.`);
      return line("link-secrets", "PASS", "The link held none of the login's secrets and paid exactly one address.");
    }),
  );

  lines.push(
    await guarded("copycat-refused", async () => {
      const a = await t.begin("victim");
      links.push(a.link);
      const p = await t.pay(a.handle, a.link, "wallet-A");
      wallets.push(p.walletAddress);
      const stolen = await t.submit(a.handle, p.payment, "copycat");
      note(stolen);
      const mine = await t.submit(a.handle, p.payment, "owner");
      note(mine);
      if (stolen.ok) return line("copycat-refused", "FAIL", "Someone who only saw the payment logged in as the user.");
      if (!mine.ok) return line("copycat-refused", "FAIL", "The copycat was refused, but that also locked the real user out of their own payment.");
      return line("copycat-refused", "PASS", "A copycat was refused, and the real user could still use the same payment.");
    }),
  );

  // Last, because it reads everything the other checks left behind.
  lines.splice(
    4,
    0,
    await guarded("sender-hidden", async () => {
      if (!t.stored) return line("sender-hidden", "SKIPPED", "This login does not offer a way to read what it stored, so the check was not run.");
      const text = [await t.stored(), ...replies, ...links].join("\n");
      const found = [...new Set(wallets)].filter((w) => w && text.includes(w)).length;
      return found > 0
        ? line("sender-hidden", "FAIL", `The paying wallet's address appears in what the site stored or replied (${found} of ${new Set(wallets).size} addresses).`)
        : line("sender-hidden", "PASS", `Searched what the site stored and every reply for ${new Set(wallets).size} paying addresses: none found.`);
    }),
  );

  const count = (s: CheckStatus) => lines.filter((l) => l.status === s).length;
  return { name: t.name, passed: count("PASS"), failed: count("FAIL"), skipped: count("SKIPPED"), lines };
}

/** The scorecard as plain text, the same words in the terminal and in tests. */
export function scorecardText(s: Scorecard): string {
  const out = [`Login scorecard: ${s.name}`, ""];
  for (const l of s.lines) out.push(`${l.status.padEnd(7)} ${l.title}`, `        ${l.detail}`);
  out.push("", `RESULT: ${s.failed === 0 ? "PASS" : "FAIL"} (${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ""})`);
  return out.join("\n");
}
