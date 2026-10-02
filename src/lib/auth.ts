import { createHash } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { createTransport } from "nodemailer";
import { normalizeAuthEmail, prepareEmailToken, sheetsAuthAdapter } from "./auth-adapter";
import { findActiveMemberByEmail } from "./sheets";

const adapter = sheetsAuthAdapter();
const LINK_SECONDS = 15 * 60;

export function smtpTransportOptions(value: string, production = process.env.NODE_ENV === "production") {
  const url = new URL(value);
  if (!["smtp:", "smtps:"].includes(url.protocol) || !url.hostname ||
      url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("Invalid SMTP configuration.");
  }
  const secure = url.protocol === "smtps:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const localTest = !production && ["localhost", "127.0.0.1", "::1"].includes(host);
  return {
    host,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    ignoreTLS: false,
    requireTLS: !secure && !localTest,
    tls: { rejectUnauthorized: true },
    ...(url.username || url.password ? {
      auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

function siteUrl(): URL | null {
  try {
    const url = new URL(process.env.NEXTAUTH_URL ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function isAuthSessionConfigured() {
  return Boolean(process.env.NEXTAUTH_SECRET && siteUrl());
}

export function getAuthAvailability() {
  let smtp = false;
  try {
    smtp = Boolean(process.env.EMAIL_SERVER && smtpTransportOptions(process.env.EMAIL_SERVER));
  } catch {
    smtp = false;
  }
  const common = Boolean(
    isAuthSessionConfigured() && process.env.GOOGLE_SHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.APPS_SCRIPT_GATEWAY_URL &&
    process.env.APPS_SCRIPT_GATEWAY_SECRET,
  );
  return {
    google: common && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    email: common && smtp && Boolean(process.env.EMAIL_FROM),
  };
}

export function safeAuthRedirect(url: string, baseUrl: string): string {
  try {
    const base = siteUrl() ?? new URL(baseUrl);
    const target = new URL(url, base.origin);
    if (target.origin === base.origin && !target.username && !target.password) return target.href;
    return base.origin;
  } catch {
    return siteUrl()?.origin ?? baseUrl;
  }
}

const availability = getAuthAvailability();
export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  adapter,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  debug: false,
  logger: {
    // Never log NextAuth metadata: it can contain bearer tokens and magic URLs.
    error() { console.error("Authentication request failed."); },
    warn() { console.warn("Authentication configuration warning."); },
    debug() {},
  },
  providers: [
    ...(availability.google ? [GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    })] : []),
    ...(availability.email ? [EmailProvider({
      server: process.env.EMAIL_SERVER!,
      from: process.env.EMAIL_FROM!,
      maxAge: LINK_SECONDS,
      normalizeIdentifier: normalizeAuthEmail,
      async sendVerificationRequest({ identifier, token, expires, url, provider }) {
        try {
          const hash = createHash("sha256").update(`${token}${provider.secret ?? process.env.NEXTAUTH_SECRET!}`).digest("hex");
          const allowed = await prepareEmailToken({ identifier, token: hash, expires });
          if (!allowed) return;
          if (typeof provider.server !== "string") throw new Error("Invalid SMTP configuration.");
          const transport = createTransport(smtpTransportOptions(provider.server));
          try {
            await transport.sendMail({
              to: normalizeAuthEmail(identifier), from: provider.from,
              subject: "Your running club sign-in link",
              text: `Sign in to your running club:\n\n${url}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this email.`,
            });
          } finally {
            transport.close();
          }
        } catch {
          // SMTP and eligibility failures have the same public result as a
          // denied request; neither the email nor the token is logged.
          console.error("Authentication email delivery unavailable.");
        }
      },
    })] : []),
  ],
  pages: {
    signIn: "/auth/signin", verifyRequest: "/auth/check-inbox", error: "/auth/error",
  },
  callbacks: {
    async signIn({ user, account, profile, email }) {
      if (account?.provider === "email" && email?.verificationRequest) {
        // Eligibility is enforced inside the locked issuance operation. Always
        // show the same response before revealing whether membership exists.
        return true;
      }
      try {
        if (!account || !getAuthAvailability()[account.provider === "google" ? "google" : "email"]) return false;
        if (account.provider === "google") {
          const google = profile as { email?: string; email_verified?: boolean; sub?: string } | undefined;
          if (google?.email_verified !== true || !google.email || google.sub !== account.providerAccountId) return false;
          const address = normalizeAuthEmail(google.email);
          if (!user.email || normalizeAuthEmail(user.email) !== address) return false;
          const member = await findActiveMemberByEmail(address);
          if (!member) return false;
          // Only Google's verified identity plus the live, unambiguous membership
          // can link an account. No blanket allowDangerousEmailAccountLinking.
          const stored = await adapter.createUser!({
            email: address, name: user.name, image: user.image, emailVerified: new Date(),
          });
          const linked = await adapter.getUserByAccount!({
            provider: "google", providerAccountId: account.providerAccountId,
          });
          if (linked && linked.id !== stored.id) return false;
          await adapter.linkAccount!({ ...account, userId: stored.id });
          return true;
        }
        if (account.provider !== "email" || !user.email) return false;
        return Boolean(await findActiveMemberByEmail(normalizeAuthEmail(user.email)));
      } catch {
        return false;
      }
    },
    async redirect({ url, baseUrl }) {
      return safeAuthRedirect(url, baseUrl);
    },
    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.email = typeof token.email === "string" ? token.email : null;
      return session;
    },
  },
};
