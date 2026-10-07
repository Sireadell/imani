// The fixed plan behind test/login/vectors/login-offline.json. Both the input maker
// (make-offline-inputs.ts) and the offline test use it, so the codes the test puts in its
// store are exactly the ones the memos inside the transactions were signed for.
import { buildLoginMemo, createChallenge, MemoryChallengeStore, type Challenge } from "../../src/login/index.ts";
import { T0, fixedKey, fixedRandom } from "./helpers.ts";

export const SITE_ID = "shop.example";
export const OTHER_SITE_ID = "other.example";
// Addresses printed by `gen_login parties` (fixed throwaway seeds).
export const SITE_ADDRESS =
  "utest1tjdul4tkqcq73y9rswhestu750ssp7qsw4g5ak3xrm9nvu5gdtng46xqaq3cucxrs58y69wf2rgg0x4tlunja5mxkmm9caqgh5vudxju";
export const HEIGHT_IRONWOOD = 4_200_010;
export const HEIGHT_ORCHARD = 3_600_010;

export interface PlannedPayment {
  label: string;
  /** Code label from CODES, or "other-site" for a code minted by other.example. */
  code: string;
  account: string;
  wallet: "user wallet A" | "user wallet B" | "someone else";
  to: "site shop.example" | "site other.example";
  pool: "ironwood" | "orchard";
  amountZat: number;
}

export const CODES = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;

export const PAYMENTS: PlannedPayment[] = [
  { label: "login_wallet_a", code: "c1", account: "user", wallet: "user wallet A", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
  { label: "login_wallet_b", code: "c2", account: "user", wallet: "user wallet B", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
  { label: "login_orchard_wallet_a", code: "c3", account: "user", wallet: "user wallet A", to: "site shop.example", pool: "orchard", amountZat: 25_000 },
  { label: "copied_memo_other_wallet", code: "c1", account: "user", wallet: "someone else", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
  { label: "memo_for_other_site", code: "other-site", account: "user", wallet: "user wallet A", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
  { label: "paid_to_other_site", code: "c4", account: "user", wallet: "user wallet A", to: "site other.example", pool: "ironwood", amountZat: 10_000 },
  { label: "below_minimum", code: "c5", account: "user", wallet: "user wallet A", to: "site shop.example", pool: "ironwood", amountZat: 5_000 },
  { label: "late_payment", code: "c6", account: "user", wallet: "user wallet B", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
  { label: "second_account_same_wallet", code: "c7", account: "second user", wallet: "user wallet A", to: "site shop.example", pool: "ironwood", amountZat: 10_000 },
];

/** Recreate the site's codes in a fresh store, exactly as when the vectors were made. */
export async function siteCodes(store = new MemoryChallengeStore()) {
  const codes: Record<string, Challenge> = {};
  for (const c of CODES) {
    codes[c] = await createChallenge(store, { siteId: SITE_ID, siteAddress: SITE_ADDRESS, network: "test", now: T0, random: fixedRandom(`offline code ${c}`) });
  }
  const otherStore = new MemoryChallengeStore();
  codes["other-site"] = await createChallenge(otherStore, {
    siteId: OTHER_SITE_ID,
    siteAddress: "utest18kxf5kuy97jk4egfk7eyrh0m3rf30d9c8s4eze5apw4ls6xh0pa7pcy0z7v7zkpwx56zszvh42ggvvhua8wjx2shguah4axcmcy8vcsz",
    network: "test",
    now: T0,
    random: fixedRandom("offline code other site"),
  });
  return { store, codes };
}

export function memoFor(p: PlannedPayment, codes: Record<string, Challenge>): string {
  return buildLoginMemo(fixedKey(p.account), codes[p.code]);
}
