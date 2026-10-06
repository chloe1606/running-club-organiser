import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions, getAuthAvailability, isAuthSessionConfigured } from "../../../../lib/auth";

const handler = NextAuth(authOptions);
export const runtime = "nodejs";

async function configuredHandler(
  request: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
) {
  const availability = getAuthAvailability();
  const [action, provider] = (await context.params).nextauth;
  const requestedProviderAvailable = !provider || (provider === "google" ? availability.google :
    provider === "email" ? availability.email : false);
  const requiresProvider = action === "signin" || action === "callback";
  if (!isAuthSessionConfigured() || (requiresProvider &&
      ((!availability.google && !availability.email) || !requestedProviderAvailable))) {
    return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  }
  return handler(request, context);
}

export { configuredHandler as GET, configuredHandler as POST };
