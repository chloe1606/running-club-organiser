"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function GoogleSignIn({ callbackUrl }: { callbackUrl: string }) {
  const [busy, setBusy] = useState(false);
  return <button type="button" disabled={busy} onClick={() => {
    setBusy(true);
    void signIn("google", { callbackUrl }).catch(() => setBusy(false));
  }}>{busy ? "Connecting to Google…" : "Continue with Google"}</button>;
}

export function EmailSignIn({ callbackUrl = "/", resend = false }: { callbackUrl?: string; resend?: boolean }) {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(resend ? 60 : 0);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!remaining) return;
    const timer = setTimeout(() => setRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  return <form style={{ display: "grid", gap: ".8rem", marginTop: "1rem" }} onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn("email", { email: address.trim(), redirect: false, callbackUrl });
    } catch {
      // The public outcome intentionally does not reveal eligibility or delivery.
    } finally {
      setBusy(false);
      setRemaining(60);
      setStatus("If this address belongs to an active member, a sign-in link will arrive shortly.");
      if (!resend) router.push("/auth/check-inbox");
    }
  }}>
    <label htmlFor={resend ? "resend-email" : "signin-email"}>Membership email address</label>
    <input id={resend ? "resend-email" : "signin-email"} name="email" type="email" autoComplete="email"
      required value={address} onChange={(event) => setAddress(event.target.value)}
      style={{ font: "inherit", padding: ".85rem", border: "1px solid #64748b", borderRadius: ".45rem", width: "100%" }} />
    <button type="submit" disabled={busy || remaining > 0}>
      {busy ? "Requesting link…" : remaining > 0 ? `Resend available in ${remaining}s` : resend ? "Resend sign-in link" : "Email me a sign-in link"}
    </button>
    <p role="status" aria-live="polite">{status || "No password needed. The link expires after 15 minutes and works once."}</p>
  </form>;
}
