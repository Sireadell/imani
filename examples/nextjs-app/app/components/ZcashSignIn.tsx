"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { buildLoginMemo, buildLoginProof, exportLoginKey, formatZec, newLoginKey, paymentLink, siteKey, EXPORT_WARNING } from "@/lib/browser-login.js";

type Challenge = { nonce: string; siteId: string; siteAddress: string; network: string; expiresAt: number; minZat: number };

// The login key lives in this component's memory only. It is never sent, never put in a web
// address and never written to browser storage. Closing the tab forgets it, so save the backup.
export default function ZcashSignIn({ siteId }: { siteId: string }) {
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function makeKey() {
    setKey(newLoginKey());
  }

  function saveBackup() {
    if (!key) return;
    const text = `${exportLoginKey(key)}\n\n${EXPORT_WARNING}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "imani-login-key-backup.txt" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function getCode() {
    if (!key) return;
    setError("");
    setBusy(true);
    try {
      // Reserve the code for this page's own account id, so someone who only sees it cannot use it up.
      const { accountId } = await siteKey(key, siteId);
      const c = await fetch("/api/zcash-login/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      }).then((r) => r.json());
      if (!c.nonce) throw new Error(c.message ?? "Could not get a sign-in code.");
      const { memo } = await buildLoginMemo(key, c);
      setChallenge(c);
      setLink(paymentLink(c.siteAddress, c.minZat, memo));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get a sign-in code.");
    } finally {
      setBusy(false);
    }
  }

  // The pretend wallet: sends only the payment (address, amount, memo), like a real wallet would.
  async function payAndSignIn() {
    if (!key || !challenge) return;
    setError("");
    setBusy(true);
    try {
      const sent = await fetch("/api/sim/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: link }),
      }).then((r) => r.json());
      if (!sent.ok) throw new Error(sent.message);
      // The proof stays on this page and goes only to this site. It is not in the payment link.
      const proof = await buildLoginProof(key, challenge);
      const res = await signIn("zcash", { txHex: sent.txHex, proof, redirect: false });
      if (res?.error) throw new Error("The payment was not accepted. Get a new code and try again.");
      window.location.assign("/account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Sign in with a private Zcash wallet</h2>
      <p>No email and no password. Your wallet sends a tiny private payment that carries a signed note, and this site reads it.</p>
      <ol>
        <li>
          <button type="button" onClick={makeKey} disabled={!!key}>Make my account key</button>
          {key && (
            <p>
              Made on this device. <button type="button" onClick={saveBackup}>Save backup file</button>
              <br /><small>{EXPORT_WARNING}</small>
            </p>
          )}
        </li>
        <li>
          <button type="button" onClick={getCode} disabled={!key || busy}>Get a sign-in code</button>
          {challenge && <p>Code: <code>{challenge.nonce}</code>. Pay {formatZec(challenge.minZat)} ZEC to the site address with the note below.</p>}
          {link && <textarea readOnly rows={3} value={link} aria-label="Payment link" style={{ width: "100%" }} />}
        </li>
        <li>
          <button type="button" onClick={payAndSignIn} disabled={!challenge || busy}>Pay from the pretend wallet</button>
          <p><small>Simulated: this example has no real wallet or network. A real site would show the link as a QR code.</small></p>
        </li>
      </ol>
      {error && <p role="alert" style={{ color: "#b00020" }}>{error}</p>}
    </section>
  );
}
