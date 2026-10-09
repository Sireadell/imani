import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { kit } from "@/lib/kit";

// A page only a signed-in visitor can see.
export default async function Account() {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) redirect("/");
  // The receipt is read from the login kit's real storage, not written by hand. It also searches
  // everything the kit holds for the site's own secrets and reports how many times each was found.
  const receipt = kit.receipt(id, {
    probes: process.env.AUTH_SECRET ? [{ label: "the site's session secret", value: process.env.AUTH_SECRET }] : [],
  });
  return (
    <section>
      <h1>My account</h1>
      <p>Account id: <code>{id}</code></p>
      <h2>Receipt: what this site stored about you</h2>
      <p>Read from the login kit's storage just now. The account id is a public key your device made for this site alone, so another site cannot match it to you. The site never saw your wallet address, your name or your email.</p>
      <table>
        <thead><tr><th>Where</th><th>What</th><th>Value</th></tr></thead>
        <tbody>
          {receipt.stored.map((f, i) => (
            <tr key={i}>
              <td>{f.where}</td>
              <td>{f.field}</td>
              <td>{f.value.length > 40 ? `${f.value.slice(0, 18)}...${f.value.slice(-8)}` : f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{receipt.shared.map((f) => `${f.field}: ${f.value} (kept for all accounts together, not tied to you)`).join(" ")}</p>
      <h3>Searched {receipt.scanned} stored values for things the site must not hold</h3>
      <ul>
        {receipt.notStored.map((n) => (
          <li key={n.label}>{n.label}: found in {n.found}</li>
        ))}
      </ul>
      <p><Link href="/">Back home</Link></p>
    </section>
  );
}
