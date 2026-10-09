import Link from "next/link";
import { auth, signOut } from "@/auth";
import ZcashSignIn from "./components/ZcashSignIn";
import { SITE_ID } from "@/lib/kit";

export default async function Page() {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  return (
    <section>
      <h1>Home</h1>
      <p className="muted">The Next.js authentication example, with the Zcash login in place of GitHub. Simulated: no real money moves.</p>
      {id ? (
        <form
          action={async () => {
            "use server";
            await signOut();
          }}
        >
          <p>You are signed in as account <code>{id.slice(0, 6)}</code>. <Link href="/account">Open my account</Link></p>
          <button type="submit">Sign out</button>
        </form>
      ) : (
        <ZcashSignIn siteId={SITE_ID} />
      )}
    </section>
  );
}
