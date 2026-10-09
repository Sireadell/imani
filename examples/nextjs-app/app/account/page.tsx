import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";

// A page only a signed-in visitor can see.
export default async function Account() {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) redirect("/");
  return (
    <section>
      <h1>My account</h1>
      <p>Account id: <code>{id}</code></p>
      <h2>What this site knows about you</h2>
      <p>Only that id. It is a public key your device made for this site alone, so another site cannot match it to you. The site never saw your wallet address, your name or your email.</p>
      <p><Link href="/">Back home</Link></p>
    </section>
  );
}
