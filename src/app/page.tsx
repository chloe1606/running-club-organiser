import { getServerSession } from "next-auth";
import { ClubPage } from "@/components/club-page";
import { authOptions } from "@/lib/auth";
import SignInPage from "./auth/signin/page";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: {
	searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
	if (process.env.CLUB_DEMO_MODE === "true") return <ClubPage />;
	const session = await getServerSession(authOptions);
	if (session?.user?.email) return <ClubPage />;
	return <SignInPage searchParams={searchParams} />;
}
