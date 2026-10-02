import Link from "next/link";

export default function AuthErrorPage() {
  return <main style={{ maxWidth: "640px" }}>
    <p className="eyebrow">Sign-in help</p>
    <h1 style={{ fontSize: "3rem" }}>Let&apos;s try again</h1>
    <p className="intro" role="alert">Sign-in could not be completed. Your email link may have expired or already been used.</p>
    <p>Request a fresh link or try Google using your membership email address. If you still cannot sign in, contact the club organiser.</p>
    <Link href="/auth/signin">Back to sign-in</Link>
  </main>;
}
