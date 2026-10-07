import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountKey,
  buildLoginMemo,
  buildLoginProof,
  buildPaymentUri,
  checkSinglePayee,
  createChallenge,
  exportAccountKey,
  importAccountKey,
  makeNonce,
  MemoryChallengeStore,
  parseLoginMemo,
  verifyLoginPayment,
  formatZec,
  looksLikeKey,
  MEMO_LIMIT,
} from "../../src/login/index.ts";
import { FAKE_ADDRESS, FAKE_UFVK, SITE, T0, fakeChain, fixedKey } from "./helpers.ts";

// What the user's page would send along with the payment: a proof made with the same key as the memo.
const proofs = new Map<string, string>();
function memoBy(key: AccountKey, c: Parameters<typeof buildLoginMemo>[1]): string {
  const memo = buildLoginMemo(key, c);
  proofs.set(memo, buildLoginProof(key, c));
  return memo;
}
const proofOf = (chain: ReturnType<typeof fakeChain>, tx: string): string | undefined => proofs.get(chain.memoOf(tx) ?? "");

async function setup(opts: { minZat?: number } = {}) {
  const store = new MemoryChallengeStore();
  const chain = fakeChain();
  const challenge = await createChallenge(store, { siteId: SITE, siteAddress: FAKE_ADDRESS, network: "test", now: T0, minZat: opts.minZat });
  const verify = (txHex: string, now = T0 + 5, siteId = SITE) =>
    verifyLoginPayment(txHex, FAKE_UFVK, store, { siteId, siteAddress: FAKE_ADDRESS, now, readTx: chain.readTx, proof: proofOf(chain, txHex) });
  return { store, chain, challenge, verify };
}

test("codes are readable, grouped and never repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = makeNonce();
    assert.match(c, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){4}$/);
    assert.ok(!/[01OIL]/.test(c));
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test("a challenge carries site, address, network, expiry and minimum", async () => {
  const { challenge } = await setup();
  assert.equal(challenge.siteId, SITE);
  assert.equal(challenge.siteAddress, FAKE_ADDRESS);
  assert.equal(challenge.network, "test");
  assert.equal(challenge.expiresAt, T0 + 600);
  assert.equal(challenge.minZat, 10_000);
});

test("createChallenge refuses an address from the other network", async () => {
  await assert.rejects(createChallenge(new MemoryChallengeStore(), { siteId: SITE, siteAddress: "u1" + "p".repeat(100), network: "test" }));
});

test("the login memo is versioned text well under 512 bytes", async () => {
  const { challenge } = await setup();
  const memo = memoBy(fixedKey("alice"), challenge);
  const lines = memo.split("\n");
  assert.equal(lines[0], "imani-login:1");
  assert.deepEqual(lines.map((l) => l.split(":")[0]).slice(1), ["site", "net", "code", "exp", "key", "sig"]);
  assert.ok(Buffer.byteLength(memo) < 260, `memo is ${Buffer.byteLength(memo)} bytes`);
  // Longest allowed site id still fits.
  const long = { ...challenge, siteId: "a".repeat(100) + ":65535" };
  assert.ok(Buffer.byteLength(memoBy(fixedKey("alice"), long)) <= MEMO_LIMIT);
});

test("payment link follows ZIP 321: one address, decimal ZEC amount, base64url memo without padding", async () => {
  const { challenge } = await setup();
  const memo = memoBy(fixedKey("alice"), challenge);
  const uri = buildPaymentUri(challenge, memo);
  assert.match(uri, /^zcash:utest1p+\?amount=0\.0001&memo=[A-Za-z0-9_-]+$/);
  const b64 = uri.split("memo=")[1];
  assert.equal(Buffer.from(b64, "base64url").toString("utf8"), memo);
  assert.deepEqual(checkSinglePayee(uri), { ok: true, address: FAKE_ADDRESS });
  assert.equal(formatZec(1), "0.00000001");
  assert.equal(formatZec(100_000_000), "1");
  assert.equal(formatZec(150_000_000), "1.5");
});

test("the link checker refuses links with a hidden second payee or unknown required parameter", () => {
  const a = "zcash:utest1abc?amount=0.0001&address.1=utest1evil&amount.1=5";
  assert.equal(checkSinglePayee(a).ok, false);
  assert.equal(checkSinglePayee("zcash:utest1abc?amount=1&amount=2").ok, false);
  assert.equal(checkSinglePayee("zcash:utest1abc?req-future=1").ok, false);
  assert.equal(checkSinglePayee("zcash:?address=utest1abc").ok, false);
});

test("a good login returns the account id, and the code then dies", async () => {
  const { chain, challenge, verify } = await setup();
  const key = fixedKey("alice");
  const tx = chain.pay(memoBy(key, challenge));
  const r = await verify(tx);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.accountId, key.siteKey(SITE).publicKey);
  assert.deepEqual(r.ok && Object.keys(r.siteLearned).sort(), ["accountId", "amountZat", "pool"]);
  // Same memo in a new transaction: the code is used up.
  const again = await verify(chain.pay(memoBy(key, challenge)));
  assert.equal(!again.ok && again.reason, "code_already_used");
  // The very same transaction again.
  const same = await verify(tx);
  assert.equal(!same.ok && same.reason, "transaction_already_used");
});

test("the same login key gives different account ids on different sites", () => {
  const key = fixedKey("alice");
  assert.notEqual(key.siteKey("shop.example").publicKey, key.siteKey("forum.example").publicKey);
  assert.equal(key.siteKey("shop.example").publicKey, fixedKey("alice").siteKey("shop.example").publicKey);
});

const refusals: [string, (s: Awaited<ReturnType<typeof setup>>) => Promise<string>][] = [
  ["code_expired", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), challenge)), challenge.expiresAt + 1);
    return r.ok ? "ok" : r.reason;
  }],
  ["wrong_site", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), { ...challenge, siteId: "other.example" })));
    return r.ok ? "ok" : r.reason;
  }],
  ["wrong_network", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), { ...challenge, network: "main" })));
    return r.ok ? "ok" : r.reason;
  }],
  ["unknown_code", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), { ...challenge, nonce: "2222-3333-4444-5555-6666" })));
    return r.ok ? "ok" : r.reason;
  }],
  ["code_mismatch", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), { ...challenge, expiresAt: challenge.expiresAt + 3600 })));
    return r.ok ? "ok" : r.reason;
  }],
  ["bad_signature", async ({ chain, challenge, verify }) => {
    const memo = memoBy(fixedKey("a"), challenge);
    const other = memoBy(fixedKey("b"), challenge);
    // Keep a's signature, swap in b's key: someone trying to log in as b.
    const forged = memo.replace(/key:.*/, other.match(/key:.*/)![0]);
    const r = await verify(chain.pay(forged));
    return r.ok ? "ok" : r.reason;
  }],
  ["amount_too_low", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), challenge), 9_999));
    return r.ok ? "ok" : r.reason;
  }],
  ["no_login_memo", async ({ chain, verify }) => {
    const r = await verify(chain.pay("thanks for the coffee"));
    return r.ok ? "ok" : r.reason;
  }],
  ["memo_malformed", async ({ chain, challenge, verify }) => {
    const memo = memoBy(fixedKey("a"), challenge);
    const r = await verify(chain.pay(memo.slice(0, 120)));
    return r.ok ? "ok" : r.reason;
  }],
  ["nothing_for_this_site", async ({ chain, challenge, verify }) => {
    const r = await verify(chain.pay(memoBy(fixedKey("a"), challenge), 10_000, "outgoing"));
    return r.ok ? "ok" : r.reason;
  }],
  ["several_login_memos", async ({ chain, challenge, verify }) => {
    const m = memoBy(fixedKey("a"), challenge);
    const r = await verify(chain.raw([
      { pool: "ironwood", amountZat: 10_000, memo: m, transferType: "incoming" },
      { pool: "ironwood", amountZat: 10_000, memo: m, transferType: "incoming" },
    ]));
    return r.ok ? "ok" : r.reason;
  }],
  ["unreadable_transaction", async ({ verify }) => {
    const r = await verify("zz-not-hex");
    return r.ok ? "ok" : r.reason;
  }],
];

for (const [reason, run] of refusals) {
  test(`refused with ${reason}`, async () => {
    const s = await setup();
    assert.equal(await run(s), reason);
    // A refused attempt never uses up the code: the real user can still log in.
    const ok = await s.verify(s.chain.pay(memoBy(fixedKey("real user"), s.challenge)));
    assert.equal(ok.ok, true);
  });
}

test("a code made for a different receiving address is refused", async () => {
  const store = new MemoryChallengeStore();
  const chain = fakeChain();
  const c = await createChallenge(store, { siteId: SITE, siteAddress: "utest1" + "x".repeat(200), network: "test", now: T0 });
  const tx = chain.pay(memoBy(fixedKey("a"), c));
  const r = await verifyLoginPayment(tx, FAKE_UFVK, store, { siteId: SITE, siteAddress: FAKE_ADDRESS, now: T0, readTx: chain.readTx, proof: proofOf(chain, tx) });
  assert.equal(!r.ok && r.reason, "wrong_address");
});

test("a mainnet viewing key refuses a testnet memo", async () => {
  const { chain, challenge, store } = await setup();
  const tx = chain.pay(memoBy(fixedKey("a"), challenge));
  const r = await verifyLoginPayment(tx, "uview1" + "q".repeat(300), store, { siteId: SITE, now: T0, readTx: chain.readTx, proof: proofOf(chain, tx) });
  assert.equal(!r.ok && r.reason, "wrong_network");
});

test("two logins racing with one code: exactly one wins", async () => {
  const { chain, challenge, verify } = await setup();
  const txs = [1, 2, 3, 4, 5].map((i) => chain.pay(memoBy(fixedKey(`racer ${i}`), challenge)));
  const results = await Promise.all(txs.map((t) => verify(t)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "code_already_used"));
});

test("stores are separate: a code from one site's store is unknown to another", async () => {
  const a = await setup();
  const b = await setup();
  const tx = a.chain.pay(memoBy(fixedKey("x"), a.challenge));
  const r = await verifyLoginPayment(tx, FAKE_UFVK, b.store, { siteId: SITE, now: T0, readTx: a.chain.readTx, proof: proofOf(a.chain, tx) });
  assert.equal(!r.ok && r.reason, "unknown_code");
});

test("export and import give back the same account; bad backups fail without echoing the input", () => {
  const key = AccountKey.generate();
  const text = exportAccountKey(key);
  assert.match(text, /^imani-login-key-1:[A-Za-z0-9_-]{43}$/);
  assert.equal(importAccountKey(text).siteKey(SITE).publicKey, key.siteKey(SITE).publicKey);
  for (const bad of ["hello", "imani-login-key-1:abc", text.slice(0, -2)]) {
    assert.throws(() => importAccountKey(bad), (e: Error) => !e.message.includes(bad));
  }
});

test("key-shaped text is refused in memos", () => {
  assert.equal(looksLikeKey("uviewtest1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(3)), true);
  assert.equal(looksLikeKey(memoBy(fixedKey("a"), { siteId: SITE, network: "test", nonce: "2222-3333-4444-5555-6666", expiresAt: T0 })), false);
  assert.throws(() => buildPaymentUri({ siteAddress: FAKE_ADDRESS, network: "test", minZat: 1 }, "zxviews1" + "q".repeat(60)));
});

test("parser rejects extra lines, reordered fields and spaces", async () => {
  const { challenge } = await setup();
  const memo = memoBy(fixedKey("a"), challenge);
  assert.equal(parseLoginMemo(memo).ok, true);
  assert.equal(parseLoginMemo(memo + "\nextra:1").ok, false);
  assert.equal(parseLoginMemo(memo.replace("site:", "site: ")).ok, false);
  const l = memo.split("\n");
  assert.equal(parseLoginMemo([l[0], l[2], l[1], ...l.slice(3)].join("\n")).ok, false);
  assert.equal(parseLoginMemo(memo.replace("imani-login:1", "imani-login:2")).ok, false);
  assert.equal(parseLoginMemo(memo + "\u0000\u0000").ok, true);
});
