// Builds docs/login/vectors.json deterministically from fixed seeds.
// Write the file:   npx tsx test/login/conformance-vectors.ts --write
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AccountKey, buildLoginMemo, buildPaymentUri, signedText, checkLoginMemo, makeNonce } from "../../src/login/index.ts";
import { fixedRandom } from "./helpers.ts";

const seed = (label: string) => createHash("sha256").update(`imani login conformance: ${label}`).digest();
const ADDRESS = "utest1tjdul4tkqcq73y9rswhestu750ssp7qsw4g5ak3xrm9nvu5gdtng46xqaq3cucxrs58y69wf2rgg0x4tlunja5mxkmm9caqgh5vudxju";
const NOW = 1_790_000_000;

export function makeVectors() {
  const challenge = (siteId: string, network: "main" | "test", label: string, expiresAt = NOW + 600) => ({
    siteId,
    network,
    nonce: makeNonce(fixedRandom(`conformance nonce ${label}`)),
    expiresAt,
  });

  // 1. Per-site key derivation: HMAC-SHA256(seed, "imani login site key v1\n" + siteId) is the Ed25519 seed.
  const derive = [
    ["alice", "shop.example"],
    ["alice", "forum.example"],
    ["bob", "shop.example"],
    ["bob", "localhost:3000"],
  ].map(([who, siteId]) => ({
    accountSeedHex: seed(who).toString("hex"),
    siteId,
    accountId: AccountKey.fromSeed(seed(who)).siteKey(siteId).publicKey,
  }));

  // 2. Building a memo and payment link. Ed25519 signatures are deterministic, so these match exactly.
  const build = [
    { who: "alice", c: challenge("shop.example", "test", "b1"), minZat: 10_000 },
    { who: "bob", c: challenge("localhost:3000", "main", "b2"), minZat: 123_456_789 },
  ].map(({ who, c, minZat }) => {
    const key = AccountKey.fromSeed(seed(who));
    const memo = buildLoginMemo(key, c);
    const accountId = key.siteKey(c.siteId).publicKey;
    const siteAddress = c.network === "test" ? ADDRESS : "u1" + ADDRESS.slice(6);
    return {
      accountSeedHex: seed(who).toString("hex"),
      challenge: { ...c, siteAddress, minZat },
      signedText: signedText({ ...c, accountId }),
      memo,
      memoBytes: Buffer.byteLength(memo, "utf8"),
      paymentUri: buildPaymentUri({ siteAddress, network: c.network, minZat }, memo),
    };
  });

  // 3. Checking memos. Context: siteId shop.example, network test, now NOW.
  const ctx = { siteId: "shop.example", network: "test" as const, now: NOW };
  const alice = AccountKey.fromSeed(seed("alice"));
  const good = buildLoginMemo(alice, challenge("shop.example", "test", "m1"));
  const lines = good.split("\n");
  const bobGood = buildLoginMemo(AccountKey.fromSeed(seed("bob")), challenge("shop.example", "test", "m1"));
  const flip = (s: string) => s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.slice(-1);
  const cases: [string, string][] = [
    ["valid", good],
    ["valid_with_trailing_zero_bytes", good + "\u0000\u0000\u0000"],
    ["valid_expires_exactly_now", buildLoginMemo(alice, challenge("shop.example", "test", "m2", NOW))],
    ["wrong_site", buildLoginMemo(alice, challenge("other.example", "test", "m3"))],
    ["wrong_network", buildLoginMemo(alice, challenge("shop.example", "main", "m4"))],
    ["expired", buildLoginMemo(alice, challenge("shop.example", "test", "m5", NOW - 1))],
    ["signature_flipped", [...lines.slice(0, 6), "sig:" + flip(lines[6].slice(4))].join("\n")],
    ["key_swapped", [...lines.slice(0, 5), bobGood.split("\n")[5], lines[6]].join("\n")],
    ["nonce_changed_after_signing", good.replace(/code:(....)/, (_m, g) => "code:" + (g === "2222" ? "3333" : "2222"))],
    ["expiry_changed_after_signing", good.replace(/exp:\d+/, `exp:${NOW + 999_999}`)],
    ["signature_from_other_site_key", [...lines.slice(0, 5), `key:${alice.siteKey("other.example").publicKey}`, lines[6]].join("\n")],
    ["unknown_version", good.replace("imani-login:1", "imani-login:2")],
    ["missing_line", lines.filter((l) => !l.startsWith("exp:")).join("\n")],
    ["extra_line", good + "\nnote:hi"],
    ["space_after_colon", good.replace("site:", "site: ")],
    ["windows_line_endings", good.replaceAll("\n", "\r\n")],
    ["lower_case_code", good.replace(/code:.*/, (m) => m.toLowerCase())],
    ["code_with_ambiguous_letter", good.replace(/code:./, "code:O")],
    ["expiry_leading_zero", good.replace("exp:", "exp:0")],
    ["base64_padding_in_key", good.replace(/key:(.*)/, "key:$1=")],
    ["upper_case_site", good.replace("site:shop.example", "site:SHOP.example")],
    ["too_long", good + "x".repeat(400)],
    ["empty", ""],
    ["plain_text_memo", "thanks for the coffee"],
  ];
  const check = cases.map(([name, memo]) => {
    const r = checkLoginMemo(memo, ctx);
    return { name, memo, expect: r.ok ? { ok: true, accountId: r.memo.accountId } : { ok: false, reason: r.reason } };
  });

  // 4. Payment links: a login link must pay exactly one address.
  const payee = [
    [build[0].paymentUri, true],
    [`zcash:${ADDRESS}?amount=0.0001&address.1=utest1other&amount.1=1`, false],
    [`zcash:${ADDRESS}?amount=0.0001&amount=0.0002`, false],
    [`zcash:${ADDRESS}?amount=0.0001&req-pay-later=1`, false],
    [`zcash:?address=${ADDRESS}&amount=0.0001`, false],
  ].map(([uri, ok]) => ({ uri, singlePayee: ok }));

  return {
    format: "imani-login:1",
    about:
      "Conformance vectors for imani login memos (LOGIN_SPEC.md). Throwaway seeds only. " +
      "memoCheck cases use context siteId=shop.example, network=test, now=" + NOW + " (seconds). " +
      "Reasons are checked in this order: memo_too_long, not_a_login_memo, memo_malformed, wrong_site, wrong_network, code_expired, bad_signature.",
    context: ctx,
    derive,
    build,
    memoCheck: check,
    singlePayee: payee,
  };
}

export const VECTORS_URL = new URL("../../docs/login/vectors.json", import.meta.url);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  writeFileSync(VECTORS_URL, JSON.stringify(makeVectors(), null, 2) + "\n");
  console.log("wrote docs/login/vectors.json");
}
