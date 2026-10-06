import Link from "next/link";
import { redirect } from "next/navigation";
import { getPlatformSnapshot } from "@/lib/platform";
import { ClubDashboard } from "./club-dashboard";
import { ClubBrand } from "./club-brand";

export async function ClubPage({ view = "runs", groupId }: {
  view?: "runs" | "leader" | "admin" | "profile" | "detail"; groupId?: string;
}) {
  let snapshot;
  try {
    snapshot = await getPlatformSnapshot();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 401) redirect("/auth/signin");
    return <main><nav className="club-nav"><ClubBrand /><Link href="/auth/signin">Sign in</Link></nav><section className="hero"><p className="eyebrow">Club service unavailable</p><h1>We’ll be back on pace.</h1><p className="intro" role="alert">We couldn’t load the club’s live data. No demonstration data has been substituted. Please refresh or contact a club administrator.</p><Link className="button" href="/">Try again</Link></section></main>;
  }
  return <ClubDashboard key={`${view}:${snapshot.currentMemberId ?? "public"}:${groupId ?? ""}`} initial={snapshot} view={view} groupId={groupId} />;
}
