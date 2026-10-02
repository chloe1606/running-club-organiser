import type { Adapter, AdapterAccount, AdapterSession, AdapterUser, VerificationToken } from "next-auth/adapters";
import { z } from "zod";
import { mutateSheet } from "./gateway";

export function normalizeAuthEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!z.email().safeParse(email).success) throw new Error("Invalid email address.");
  return email;
}

const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().transform(normalizeAuthEmail),
  name: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  emailVerified: z.coerce.date().nullable(),
});
const sessionSchema = z.object({
  sessionToken: z.string().min(1),
  userId: z.string().min(1),
  expires: z.coerce.date(),
});
const tokenSchema = z.object({
  identifier: z.string().transform(normalizeAuthEmail),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.coerce.date(),
});

async function command(operation: string, payload: Record<string, unknown> = {}) {
  return mutateSheet(operation, payload);
}

export async function prepareEmailToken(token: VerificationToken): Promise<boolean> {
  const result = await command("authPrepareEmail", {
    identifier: normalizeAuthEmail(token.identifier),
    token: token.token,
    expires: token.expires.toISOString(),
  });
  return z.object({ allowed: z.boolean() }).parse(result).allowed;
}

export function sheetsAuthAdapter(): Adapter {
  return {
    async createUser(user: Omit<AdapterUser, "id">) {
      return userSchema.parse(await command("authCreateUser", {
        user: { ...user, email: normalizeAuthEmail(user.email) },
      })) as AdapterUser;
    },
    async getUser(id) {
      const result = await command("authGetUser", { id });
      return result == null ? null : userSchema.parse(result);
    },
    async getUserByEmail(email) {
      const result = await command("authGetUserByEmail", { email: normalizeAuthEmail(email) });
      return result == null ? null : userSchema.parse(result);
    },
    async getUserByAccount(account) {
      const result = await command("authGetUserByAccount", { account });
      return result == null ? null : userSchema.parse(result);
    },
    async updateUser(user) {
      return userSchema.parse(await command("authUpdateUser", { user }));
    },
    async deleteUser(id) {
      await command("authDeleteUser", { id });
    },
    async linkAccount(account: AdapterAccount) {
      await command("authLinkAccount", { account });
    },
    async unlinkAccount(account: Pick<AdapterAccount, "provider" | "providerAccountId">) {
      await command("authUnlinkAccount", { account });
    },
    async createSession(session) {
      return sessionSchema.parse(await command("authCreateSession", { session }));
    },
    async getSessionAndUser(sessionToken) {
      const result = await command("authGetSessionAndUser", { sessionToken });
      return result == null ? null : z.object({ session: sessionSchema, user: userSchema }).parse(result);
    },
    async updateSession(session) {
      const result = await command("authUpdateSession", { session });
      return result == null ? null : sessionSchema.parse(result) as AdapterSession;
    },
    async deleteSession(sessionToken) {
      await command("authDeleteSession", { sessionToken });
    },
    async createVerificationToken(token) {
      // v4 sends mail and saves the hash concurrently. Both paths share one
      // idempotent, locked persistent issuance decision before any mail is sent.
      await prepareEmailToken(token);
      return token;
    },
    async useVerificationToken({ identifier, token }) {
      const result = await command("authConsumeToken", {
        identifier: normalizeAuthEmail(identifier), token,
      });
      return result == null ? null : tokenSchema.parse(result);
    },
  };
}
