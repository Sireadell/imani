import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { zcashCredentials } from "@sireadell/imani/login";
import { kit } from "@/lib/kit";

// The only change from the Next.js auth example: GitHub is replaced by the Zcash login. The
// session's user id is the account id, a public key made on the visitor's device for this site.
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [Credentials(zcashCredentials(kit))],
  session: { strategy: "jwt" },
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user = { ...session.user, id: token.sub } as typeof session.user;
      return session;
    },
  },
});
