import Link from "next/link";
import { ClubBrand } from "@/components/club-brand";

export default function AuthErrorPage() {
  return <main className="auth-main">
    <nav className="club-nav"><ClubBrand /></nav>
    <section className="auth-content">
    <p className="eyebrow">Sign-in help</p>
    <h1 style={{ fontSize: "3rem" }}>Let&apos;s try again</h1>
    <p className="intro" role="alert">Sign-in could not be completed.</p>
    <p>Sign in with your username or email and password. You can reset a forgotten password on the sign-in screen. If you still cannot sign in, contact the club organiser.</p>
    <Link href="/sign-in">Back to sign-in</Link>
    </section>
  </main>;
}
