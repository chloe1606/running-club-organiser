import { createHash } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { createTransport } from "nodemailer";
import { ZodError } from "zod";
import { normalizeAuthEmail, prepareEmailToken, sheetsAuthAdapter } from "./auth-adapter";
import { findActiveMemberByEmail } from "./sheets";

const adapter = sheetsAuthAdapter();
const LINK_SECONDS = 15 * 60;
const safeAuthErrorCodes = new Set([
  "OAUTH_CALLBACK_HANDLER_ERROR", "OAUTH_V1_GET_ACCESS_TOKEN_ERROR", "OAUTH_PARSE_PROFILE_ERROR",
  "OAUTH_CALLBACK_ERROR", "CALLBACK_EMAIL_ERROR", "SIGNIN_OAUTH_ERROR", "SIGNIN_EMAIL_ERROR",
  "adapter_error_createUser", "adapter_error_linkAccount", "adapter_error_getUserByAccount",
]);
const safeGatewayErrorCodes = new Set([
  "NOT_CONFIGURED", "UNAVAILABLE", "UNAUTHORIZED", "WORKBOOK_MISMATCH",
  "UNKNOWN_OPERATION", "AUTH_UNAVAILABLE", "LOCK_TIMEOUT", "INTERNAL_ERROR",
  "INVALID_SCHEMA", "STATE_CORRUPT", "MIGRATION_REQUIRED", "RECOVERY_REQUIRED",
  "NON_JSON_RESPONSE", "INVALID_RESPONSE",
]);

export function smtpTransportOptions(value: string, production = process.env.NODE_ENV === "production") {
  const url = new URL(value);
  if (!["smtp:", "smtps:"].includes(url.protocol) || !url.hostname ||
      url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("Invalid SMTP configuration.");
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
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

export function smtpServerUrl(): string | null {
  const host = process.env.EMAIL_SERVER_HOST?.trim();
  const port = process.env.EMAIL_SERVER_PORT?.trim();
  const user = process.env.EMAIL_SERVER_USER;
  const password = process.env.EMAIL_SERVER_PASSWORD;
  if (!host || !port || !user || !password || !/^\d+$/.test(port)) return null;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) return null;
  try {
    const hostUrl = new URL(`smtp://${host}`);
    if (!hostUrl.hostname || hostUrl.username || hostUrl.password || hostUrl.port ||
      (hostUrl.pathname && hostUrl.pathname !== "/") || hostUrl.search || hostUrl.hash) return null;
    return `smtp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostUrl.hostname}:${portNumber}/`;
  } catch {
    return null;
  }
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

let lastGoogleConfigurationWarning = "";

export function getAuthAvailability() {
  let smtp = false;
  try {
    const server = smtpServerUrl();
    smtp = Boolean(server && smtpTransportOptions(server));
  } catch {
    smtp = false;
  }
  const common = Boolean(
    isAuthSessionConfigured() && process.env.GOOGLE_SHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.APPS_SCRIPT_GATEWAY_URL &&
    process.env.APPS_SCRIPT_GATEWAY_SECRET,
  );
  const google = common && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const missing = google ? [] : [
    "NEXTAUTH_URL", "NEXTAUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON", "APPS_SCRIPT_GATEWAY_URL",
    "APPS_SCRIPT_GATEWAY_SECRET",
  ].filter((name) => !process.env[name]);
  const issues = missing.length ? [`missing or empty: ${missing.join(", ")}`] : [];
  if (process.env.NEXTAUTH_URL && !siteUrl()) {
    issues.push("NEXTAUTH_URL must be an absolute HTTP(S) URL without credentials and use HTTPS in production");
  }
  const warning = issues.length ? `Google sign-in is not configured (${issues.join("; ")}).` : "";
  if (warning && warning !== lastGoogleConfigurationWarning) console.warn(warning);
  lastGoogleConfigurationWarning = warning;
  return {
    google,
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
    error(code, metadata) {
      const safeCode = process.env.NODE_ENV === "development" && safeAuthErrorCodes.has(code) ? code : "";
      let reason = "";
      if (safeCode.startsWith("adapter_error_")) {
        if (metadata instanceof ZodError) reason = "; invalid auth record";
        else if (metadata && typeof metadata === "object" && "code" in metadata &&
          typeof metadata.code === "string" && safeGatewayErrorCodes.has(metadata.code)) {
          reason = `; gateway: ${metadata.code}`;
        }
      }
      console.error(safeCode ? `Authentication request failed (${safeCode}${reason}).` : "Authentication request failed.");
    },
    warn() { console.warn("Authentication configuration warning."); },
    debug() {},
  },
  providers: [
    ...(availability.google ? [GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    })] : []),
    ...(availability.email ? [EmailProvider({
      server: smtpServerUrl()!,
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
      let stage = "provider validation";
      try {
        if (!account || !getAuthAvailability()[account.provider === "google" ? "google" : "email"]) return false;
        if (account.provider === "google") {
          const google = profile as { email?: string; email_verified?: boolean; sub?: string } | undefined;
          if (google?.email_verified !== true || !google.email || google.sub !== account.providerAccountId) {
            console.error("Google sign-in denied during Google identity validation.");
            return false;
          }
          const address = normalizeAuthEmail(google.email);
          if (!user.email || normalizeAuthEmail(user.email) !== address) {
            console.error("Google sign-in denied because returned email claims did not match.");
            return false;
          }
          stage = "membership lookup";
          const member = await findActiveMemberByEmail(address);
          if (!member) {
            console.error("Google sign-in denied because no active membership match was found.");
            return false;
          }
          // Only Google's verified identity plus the live, unambiguous membership
          // can link an account. No blanket allowDangerousEmailAccountLinking.
          stage = "Google account persistence";
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
        console.error(`Authentication failed during ${stage}.`);
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
