import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubBrand } from "@/components/club-brand";

export default function SignInPage() {
  if (process.env.CLUB_DEMO_MODE === "true") redirect("/");
  return (
    <main className="auth-main">
      <nav className="club-nav"><ClubBrand /><Link href="/">Club Runs</Link></nav>
      <section className="auth-content">
        <h1 style={{ fontSize: "3rem" }}>Welcome back</h1>
        <p className="intro">Sign in with your username or email and password. Your verified email must match your active club membership.</p>
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/"
          appearance={{ elements: { headerTitle: { fontSize: "1.25rem", lineHeight: "1.4" } } }} />
      </section>
    </main>
  );
}
