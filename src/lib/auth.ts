import "server-only";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { GatewayError } from "./gateway";
import { findActiveMemberByEmail, type Member } from "./sheets";

export async function getClubMember(): Promise<Member | undefined> {
  const session = await auth();
  if (!session.isAuthenticated) return undefined;
  const user = await currentUser();
  const primaryEmail = user?.emailAddresses.find(email => email.id === user.primaryEmailAddressId);
  if (!user || user.id !== session.userId || primaryEmail?.verification?.status !== "verified") {
    throw new GatewayError("Verify your club membership email in your account before continuing.", 403, "EMAIL_NOT_VERIFIED");
  }

  const member = await findActiveMemberByEmail(primaryEmail.emailAddress.trim().toLowerCase());
  if (!member || (user.externalId && user.externalId !== member.memberId)) {
    throw new GatewayError("Active club membership is required. Contact the club organiser.", 403, "FORBIDDEN");
  }
  // Bind once on the server; later email changes cannot switch club identities.
  if (!user.externalId) {
    const client = await clerkClient();
    await client.users.updateUser(user.id, { externalId: member.memberId });
  }
  return member;
}
