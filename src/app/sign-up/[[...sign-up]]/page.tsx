import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubBrand } from "@/components/club-brand";

export default function SignUpPage() {
  if (process.env.CLUB_DEMO_MODE === "true") redirect("/");
  return (
    <main className="auth-main">
      <nav className="club-nav"><ClubBrand /><Link href="/">Club Runs</Link></nav>
      <section className="auth-content">
        <h1 style={{ fontSize: "3rem" }}>Set up your account</h1>
        <p className="intro">Use your organiser&apos;s invitation and the email address on your club membership. Creating a login does not create club membership or grant access.</p>
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl="/" />
      </section>
    </main>
  );
}
