import Link from "next/link";
import { getAuthAvailability } from "@/lib/auth";
import { EmailSignIn } from "../auth-form";

export const dynamic = "force-dynamic";

export default function CheckInboxPage() {
  return <main style={{ maxWidth: "640px" }}>
    <p className="eyebrow">Email sign-in</p>
    <h1 style={{ fontSize: "3rem" }}>Check your inbox</h1>
    <p className="intro" role="status">If your address belongs to an active member, a sign-in link will arrive shortly.</p>
    <p>Check your spam folder too. Links expire in 15 minutes and work only once. Request a new link if yours has expired or already been used.</p>
    <p>If nothing arrives, check your membership email with the club organiser. Requests are limited to one per minute and five per hour.</p>
    {getAuthAvailability().email && <EmailSignIn resend />}
    <Link href="/auth/signin">Use a different sign-in method</Link>
  </main>;
}
