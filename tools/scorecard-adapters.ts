// Two logins the scorecard is run against in this repo. Both are written by us:
//   imaniUnderTest: this repo's own login kit, driven the way a user and a copycat would drive it.
//   weakUnderTest:  a deliberately weak login (address as account, reusable codes, a secret in the link),
//                   to show the scorecard goes red when something is wrong. It is not anyone's real product.
// To score another login, write an adapter with the same shape (see LoginUnderTest in src/login/scorecard.ts).
import { createHash, randomBytes } from "node:crypto";
import { AccountKey, LoginKit, MemoryChallengeStore, buildLoginMemo, buildLoginProof, buildPaymentUri, checkSinglePayee, exportAccountKey, type LoginUnderTest } from "../src/login/index.ts";
import type { ReadOutput } from "../src/read.ts";

const SITE = "scorecard.example";
const ADDRESS = "utest1" + "p".repeat(200);
const UFVK = "uviewtest1" + "q".repeat(300);
const T0 = 1_790_000_000;
const TTL = 600;

const keyFor = (user: string) => AccountKey.fromSeed(createHash("sha256").update(`imani scorecard user: ${user}`).digest());

function memoOf(link: string): string {
  const q = new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("memo") ?? "";
  return Buffer.from(q, "base64url").toString("utf8");
}

/** This repo's login kit, with a pretend network that records the payments the pretend wallets make. */
export function imaniUnderTest(): LoginUnderTest {
  let now = T0;
  const store = new MemoryChallengeStore();
  const chain = new Map<string, ReadOutput[]>();
  const kit = new LoginKit({
    siteId: SITE,
    siteAddress: ADDRESS,
    viewingKey: UFVK,
    store,
    ttlSeconds: TTL,
    clock: () => now,
    readTx: (hex) => {
      const outputs = chain.get(hex);
      if (!outputs) throw new Error("unknown pretend transaction");
      return { txid: "tx" + hex, outputs };
    },
  });
  type H = { user: AccountKey; challenge: Awaited<ReturnType<LoginKit["newChallenge"]>>; proof: string };
  return {
    name: "imani login kit",
    ttlSeconds: TTL,
    async begin(user) {
      const key = keyFor(user);
      const challenge = await kit.newChallenge(key.siteKey(SITE).publicKey);
      const memo = buildLoginMemo(key, challenge);
      const handle: H = { user: key, challenge, proof: buildLoginProof(key, challenge) };
      return { handle, link: buildPaymentUri(challenge, memo) };
    },
    async pay(_h, link, wallet) {
      const hex = randomBytes(8).toString("hex");
      chain.set(hex, [{ pool: "orchard", amountZat: 10_000, memo: memoOf(link), transferType: "incoming", recipientHex: "" }]);
      return { payment: hex, walletAddress: `utest1wallet${wallet.toLowerCase().replace(/[^a-z0-9]/g, "")}${"z".repeat(40)}` };
    },
    async submit(h, payment, by) {
      const { user, challenge, proof } = h as H;
      // A copycat holds the public payment but not the user's account key, so it can only make its own proof.
      const mine = by === "owner" ? proof : buildLoginProof(keyFor("copycat"), challenge);
      const r = await kit.verify(payment as string, mine);
      return r.ok ? { ok: true, account: r.accountId, raw: JSON.stringify(r) } : { ok: false, raw: JSON.stringify(r) };
    },
    advance: (s) => void (now += s),
    secrets: (h) => [exportAccountKey((h as H).user), (h as H).proof],
    stored: async () => JSON.stringify(store.dump()),
  };
}

/** Address as account, codes that can be reused, a secret in the link, a copycat who is let in. Only the expiry works. */
export function weakUnderTest(): LoginUnderTest {
  let now = T0;
  const db: { address: string; code: string; at: number }[] = [];
  type H = { code: string; token: string; at: number };
  return {
    name: "deliberately weak example login (written by us)",
    ttlSeconds: TTL,
    async begin(user) {
      const token = createHash("sha256").update("weak token " + user).digest("hex");
      const code = randomBytes(6).toString("hex");
      return { handle: { code, token, at: now } as H, link: `zcash:${ADDRESS}?amount=0.0001&memo=${Buffer.from(code + ":" + token).toString("base64url")}` };
    },
    async pay(h, _l, wallet) {
      const walletAddress = `utest1wallet${wallet.toLowerCase().replace(/[^a-z0-9]/g, "")}${"z".repeat(40)}`;
      return { payment: { code: (h as H).code, address: walletAddress }, walletAddress };
    },
    async submit(h, payment) {
      const p = payment as { code: string; address: string };
      if (now - (h as H).at > TTL) return { ok: false, raw: '{"error":"expired"}' };
      db.push({ address: p.address, code: p.code, at: now }); // the paying address is stored
      return { ok: true, account: p.address, raw: JSON.stringify({ account: p.address }) }; // and used as the account
    },
    advance: (s) => void (now += s),
    secrets: (h) => [(h as H).token],
    stored: async () => JSON.stringify(db),
  };
}
