import Link from "next/link";
import { getAuthAvailability, safeAuthRedirect } from "@/lib/auth";
import { ClubBrand } from "@/components/club-brand";
import { EmailSignIn, GoogleSignIn } from "../auth-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const available = getAuthAvailability();
  const callbackUrl = safeAuthRedirect(params.callbackUrl ?? "/", process.env.NEXTAUTH_URL ?? "http://localhost:3000");
  return <main className="auth-main">
    <nav className="club-nav"><ClubBrand /></nav>
    <section className="auth-content">
    <p className="eyebrow">Running club</p>
    <h1 style={{ fontSize: "3rem" }}>Welcome back</h1>
    <p className="intro">Sign in with the email address on your club membership.</p>
    {params.error && <p role="alert" className="notice">Sign-in could not be completed. Please try again or ask the club organiser for help.</p>}
    {available.google ? <GoogleSignIn callbackUrl={callbackUrl} /> : <p className="notice">Google sign-in is not configured yet.</p>}
    <h2 style={{ marginTop: "2rem", fontSize: "1.4rem" }}>Or use an email link</h2>
    <p>Any email provider is welcome — you do not need a Google account.</p>
    {available.email ? <EmailSignIn callbackUrl={callbackUrl} /> : <p className="notice">Email sign-in is currently unavailable. {available.google ? "Please use Google, or contact the club organiser." : "Please contact the club organiser."}</p>}
    <Link href="/">Back to club runs</Link>
    </section>
  </main>;
}
