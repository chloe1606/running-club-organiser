import NextAuth from "next-auth";
import { authOptions, getAuthAvailability } from "@/lib/auth";

const handler = NextAuth(authOptions);
export const runtime = "nodejs";

async function configuredHandler(...args: Parameters<typeof handler>) {
  const availability = getAuthAvailability();
  if (!availability.google && !availability.email) {
    return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  }
  return handler(...args);
}

export { configuredHandler as GET, configuredHandler as POST };
