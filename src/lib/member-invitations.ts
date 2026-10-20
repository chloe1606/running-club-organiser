import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { GatewayError } from "./gateway";
import { getPlatformSnapshot } from "./platform";
import type { MemberInvitationResult } from "./platform-types";

function invitationRedirectUrl() {
  let url: URL;
  try {
    url = new URL(process.env.APP_URL ?? "");
  } catch {
    throw new GatewayError("Set APP_URL to the booking website before sending invitations.", 503, "NOT_CONFIGURED");
  }
  const secret = process.env.CLERK_SECRET_KEY ?? "";
  const publishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const developmentKeys = secret.startsWith("sk_test_") && publishable.startsWith("pk_test_");
  const productionKeys = secret.startsWith("sk_live_") && publishable.startsWith("pk_live_");
  if ((!developmentKeys && !productionKeys) || url.username || url.password ||
      !["http:", "https:"].includes(url.protocol)) {
    throw new GatewayError("Configure matching Clerk keys and a valid APP_URL before sending invitations.", 503, "NOT_CONFIGURED");
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    url.hostname.startsWith("127.") || url.hostname === "[::1]";
  if (productionKeys && (process.env.NODE_ENV !== "production" || local || url.protocol !== "https:" ||
      (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production"))) {
    throw new GatewayError("Production invitations are disabled outside the production site. Use development Clerk keys for local testing.", 503, "INVITATION_ENVIRONMENT");
  }
  if (process.env.VERCEL_ENV === "production" && !productionKeys) {
    throw new GatewayError("Use production Clerk keys on the production site before sending invitations.", 503, "INVITATION_ENVIRONMENT");
  }
  return new URL("/sign-up", url.origin).href;
}

export async function inviteClubMember(memberId: string): Promise<MemberInvitationResult> {
  const snapshot = await getPlatformSnapshot();
  const actor = snapshot.members.find(member => member.id === snapshot.currentMemberId && member.active);
  if (!actor) throw new GatewayError("Sign in to continue.", 401, "UNAUTHORIZED");
  if (!actor.roles.includes("admin")) throw new GatewayError("Administrator access is required.", 403, "FORBIDDEN");
  const member = snapshot.members.find(candidate => candidate.id === memberId);
  if (!member) throw new GatewayError("The club member was not found.", 404, "NOT_FOUND");
  if (!member.active) throw new GatewayError("Only active members can receive account invitations.", 400, "INACTIVE_MEMBER");
  if (snapshot.demo) return { memberId, status: "demo", message: "Demo only: no invitation email was sent." };

  const redirectUrl = invitationRedirectUrl();
  const emailAddress = member.email.trim().toLowerCase();
  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [emailAddress], limit: 1 });
  if (users.totalCount > 0) {
    return { memberId, status: "registered", message: "Already registered with Clerk. No invitation was sent." };
  }
  let offset = 0;
  for (;;) {
    const invitations = await client.invitations.getInvitationList({ query: emailAddress, status: "pending", limit: 100, offset });
    if (invitations.data.some(invitation => invitation.emailAddress.trim().toLowerCase() === emailAddress &&
        invitation.status === "pending")) {
      return { memberId, status: "pending", message: "An invitation is already pending. No duplicate email was sent." };
    }
    offset += invitations.data.length;
    if (offset >= invitations.totalCount) break;
    if (!invitations.data.length) throw new GatewayError("Clerk invitation lookup was incomplete. Retry before sending.", 503, "INVITATION_LOOKUP");
  }
  await client.invitations.createInvitation({ emailAddress, redirectUrl, notify: true, ignoreExisting: false });
  return { memberId, status: "sent", message: `Invitation sent to ${emailAddress}.` };
}
