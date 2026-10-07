// Auth.js (NextAuth) add-on, written without importing Auth.js. Pass the returned object to
// Auth.js's own Credentials provider:
//   import Credentials from "next-auth/providers/credentials";
//   providers: [Credentials(zcashCredentials(kit))]
import type { LoginKit } from "./kit.ts";

export interface ZcashUser {
  /** The account id: the user's per-site public key. Auth.js stores it as the user id. */
  id: string;
}

export function zcashCredentials(kit: LoginKit) {
  return {
    id: "zcash",
    name: "Zcash",
    credentials: {
      txHex: { label: "Login payment (transaction hex)", type: "text" },
    },
    async authorize(credentials: Partial<Record<string, unknown>> | undefined): Promise<ZcashUser | null> {
      const txHex = credentials?.txHex;
      if (typeof txHex !== "string") return null;
      const result = await kit.verify(txHex);
      return result.ok ? { id: result.accountId } : null;
    },
  };
}

/** A route handler for the one-time code, for example app/api/zcash-login/challenge/route.ts: export const GET = zcashChallengeRoute(kit). */
export function zcashChallengeRoute(kit: LoginKit) {
  return async function GET(): Promise<Response> {
    return new Response(JSON.stringify(await kit.newChallenge()), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
}
