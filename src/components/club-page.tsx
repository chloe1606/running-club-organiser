import Link from "next/link";
import { redirect } from "next/navigation";
import { getPlatformSnapshot } from "@/lib/platform";
import { ClubDashboard } from "./club-dashboard";
import { ClubBrand } from "./club-brand";
import { SignOut } from "./auth-controls";

async function loadDashboard() {
  const snapshot = await getPlatformSnapshot();
  return { snapshot, initialNow: Date.now() };
}

export async function ClubPage({ view = "runs", groupId }: {
  view?: "runs" | "leader" | "admin" | "profile" | "detail"; groupId?: string;
}) {
  let snapshot;
  let initialNow;
  try {
    ({ snapshot, initialNow } = await loadDashboard());
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      if (error.status === 401) redirect("/sign-in");
      if (error.status === 403) {
        return <main><nav className="club-nav"><ClubBrand /><SignOut /></nav><section className="auth-content">
          <h1>Club membership required</h1>
          <p role="alert">Your account must have a verified email matching your active club membership. Contact the club organiser if you need help.</p>
          <SignOut />
        </section></main>;
      }
    }
    return <main><nav className="club-nav"><ClubBrand /><Link href="/sign-in">Sign In</Link></nav><section className="hero"><p className="eyebrow">Club service unavailable</p><h1>We’ll be back on pace.</h1><p className="intro" role="alert">We couldn’t load the club’s live data. No demonstration data has been substituted. Please refresh or contact a club administrator.</p><Link className="button" href="/">Try Again</Link></section></main>;
  }
  return <ClubDashboard key={`${view}:${snapshot.currentMemberId ?? "public"}:${groupId ?? ""}`} initial={snapshot} initialNow={initialNow} view={view} groupId={groupId} />;
}
