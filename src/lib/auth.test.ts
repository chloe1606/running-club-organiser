import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import vm from "node:vm";
import type { NextAuthOptions } from "next-auth";
import type { VerificationToken } from "next-auth/adapters";
import type { EmailConfig } from "next-auth/providers/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAuthEmail, sheetsAuthAdapter } from "./auth-adapter";

const mocks = vi.hoisted(() => ({
  mutateSheet: vi.fn(), member: vi.fn(), sendMail: vi.fn(), close: vi.fn(),
}));
vi.mock("./gateway", () => ({ mutateSheet: mocks.mutateSheet }));
vi.mock("./sheets", () => ({ findActiveMemberByEmail: mocks.member }));
vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: mocks.sendMail, close: mocks.close }),
}));

const require = createRequire(import.meta.url);
const { AuthHandler } = require(join(dirname(require.resolve("next-auth")), "core/index.js")) as {
  AuthHandler: (params: {
    options: NextAuthOptions;
    req: { action: string; method: string; providerId?: string; body?: Record<string, string>; query?: Record<string, string>; cookies?: Record<string, string> };
  }) => Promise<{ body?: Record<string, string>; redirect?: string; cookies?: { name: string; value: string }[] }>;
};
const member = {
  id: "stable-member", email: "runner@example.org", name: "Club runner", active: true,
  roles: ["runner"], version: 1,
};

function storageHarness() {
  class Sheet {
    values: unknown[][] = [];
    hidden = false;
    protected = false;
    getRange(row: number, column: number, height = 1, width = 1) {
      const range = {
        setNumberFormat: () => range,
        getValues: () => Array.from({ length: height }, (_, r) =>
          Array.from({ length: width }, (_, c) => this.values[row - 1 + r]?.[column - 1 + c] ?? "")),
        setValues: (values: unknown[][]) => {
          values.forEach((entries, r) => entries.forEach((value, c) => {
            this.values[row - 1 + r] ??= [];
            this.values[row - 1 + r][column - 1 + c] = value;
          }));
          if (state.failAfterConsume && values.some((entries) =>
            typeof entries[1] === "string" && Boolean(JSON.parse(entries[1]).consumed))) {
            state.failAfterConsume = false;
            throw new Error("Lost acknowledgement after committed consume");
          }
          return range;
        },
      };
      return range;
    }
    getDataRange() { return { getValues: () => this.values.map((row) => [...row]) }; }
    getLastRow() { return this.values.length; }
    getProtections() { return []; }
    protect() {
      this.protected = true;
      const protection = {
        setDescription: () => protection, setWarningOnly: () => protection,
        addEditor: () => protection, removeEditors: () => protection,
        getEditors: () => [], canDomainEdit: () => false,
      };
      return protection;
    }
    isSheetHidden() { return this.hidden; }
    hideSheet() { this.hidden = true; }
  }
  const sheets = new Map<string, Sheet>();
  const state = { members: [{ ...member }], failLookup: false, failAfterConsume: false };
  const context = vm.createContext({
    Date, console,
    SpreadsheetApp: {
      ProtectionType: { SHEET: "SHEET" }, flush() {},
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => sheets.get(name),
        insertSheet: (name: string) => { const sheet = new Sheet(); sheets.set(name, sheet); return sheet; },
      }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.org" }) },
    loadPlatformState_: () => {
      if (state.failLookup) throw new Error("Lookup failed");
      return { snapshot: { members: state.members } };
    },
    response_: (ok: boolean, code: string | null, message: string | null, data: unknown) => ({ ok, code, message, data }),
  });
  vm.runInContext(readFileSync("apps-script/Auth.gs", "utf8"), context);
  let queue = Promise.resolve();
  function dispatch(operation: string, payload: Record<string, unknown> = {}) {
    // The real gateway holds ScriptLock around this synchronous dispatch.
    const call = queue.then(() => {
      const result = (context.authDispatch_ as (request: unknown) => {
        ok: boolean; data: unknown;
      })(JSON.parse(JSON.stringify({ operation, ...payload })));
      if (!result.ok) throw new Error("Authentication unavailable");
      return result.data;
    });
    queue = call.then(() => undefined, () => undefined);
    return call;
  }
  return { dispatch, state, sheets, context };
}

let store: ReturnType<typeof storageHarness>;
const token = (character = "a"): VerificationToken => ({
  identifier: member.email, token: character.repeat(64), expires: new Date(Date.now() + 15 * 60_000),
});
async function options() { return (await import("./auth")).authOptions; }
function emailProvider(config: NextAuthOptions) {
  return (config.providers.find((provider) => provider.id === "email") as EmailConfig).options!;
}
function googleParams(verified = true) {
  return {
    user: { id: "google-sub", email: member.email, name: member.name },
    account: { provider: "google", type: "oauth" as const, providerAccountId: "google-sub" },
    profile: { sub: "google-sub", email: member.email, email_verified: verified },
  };
}
async function requestEmail(config: NextAuthOptions, address: string) {
  const csrf = await AuthHandler({ options: config, req: { action: "csrf", method: "GET" } });
  return AuthHandler({
    options: config,
    req: {
      action: "signin", providerId: "email", method: "POST",
      cookies: Object.fromEntries(csrf.cookies!.map((cookie) => [cookie.name, cookie.value])),
      body: { csrfToken: csrf.body!.csrfToken, email: address, callbackUrl: "/" },
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  for (const [key, value] of Object.entries({
    NEXTAUTH_URL: "https://club.example.org", NEXTAUTH_SECRET: "test-only-auth-secret",
    GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-google-secret",
    GOOGLE_SHEET_ID: "test-workbook", GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    APPS_SCRIPT_GATEWAY_URL: "https://gateway.example.org", APPS_SCRIPT_GATEWAY_SECRET: "test-gateway-secret",
    EMAIL_SERVER: "smtp://test-mail.example.org", EMAIL_FROM: "club@example.org",
  })) vi.stubEnv(key, value);
  store = storageHarness();
  mocks.mutateSheet.mockImplementation(store.dispatch);
  mocks.member.mockResolvedValue(member);
  mocks.sendMail.mockResolvedValue({ accepted: [member.email] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("membership-restricted authentication", () => {
  it("requires Google's verified email and matching subject before persisting/linking", async () => {
    const config = await options();
    expect(await config.callbacks!.signIn!(googleParams(false))).toBe(false);
    expect(mocks.mutateSheet).not.toHaveBeenCalled();
    expect(await config.callbacks!.signIn!({
      ...googleParams(), profile: { ...googleParams().profile, sub: "different-sub" },
    })).toBe(false);
    expect(await config.callbacks!.signIn!(googleParams())).toBe(true);
    expect(await sheetsAuthAdapter().getUserByAccount!({
      provider: "google", providerAccountId: "google-sub",
    })).toMatchObject({ id: member.id, email: member.email });
  });
  it("denies inactive/nonmembers and lookup failures without throwing", async () => {
    const config = await options();
    mocks.member.mockResolvedValue(undefined);
    expect(await config.callbacks!.signIn!(googleParams())).toBe(false);
    mocks.member.mockRejectedValue(new Error("private lookup error"));
    expect(await config.callbacks!.signIn!(googleParams())).toBe(false);
    expect(await config.callbacks!.signIn!({
      user: { id: member.id, email: member.email }, account: { provider: "email", type: "email", providerAccountId: member.email },
    })).toBe(false);
    expect(await config.callbacks!.signIn!({
      user: { id: member.id, email: "outsider@example.org" },
      account: { provider: "email", type: "email", providerAccountId: "outsider@example.org" },
      email: { verificationRequest: true },
    })).toBe(true);
  });
  it("makes Google and email users share the membership ID in either order", async () => {
    const adapter = sheetsAuthAdapter();
    const emailUser = await adapter.createUser!({ email: " RUNNER@EXAMPLE.ORG ", emailVerified: new Date() });
    expect(emailUser.id).toBe(member.id);
    expect(await (await options()).callbacks!.signIn!(googleParams())).toBe(true);
    expect(await adapter.getUserByEmail!("RUNNER@example.org")).toMatchObject({ id: member.id });
    expect((await (await options()).callbacks!.jwt!({
      token: {}, user: emailUser, account: null, trigger: "signIn",
    })).sub).toBe(member.id);
  });
  it("rejects conflicting account links and ambiguous membership", async () => {
    await (await options()).callbacks!.signIn!(googleParams());
    store.state.members.push({ ...member, id: "second-member", email: "second@example.org" });
    const adapter = sheetsAuthAdapter();
    const second = await adapter.createUser!({ email: "second@example.org", emailVerified: null });
    await expect(adapter.linkAccount!({
      provider: "google", type: "oauth", providerAccountId: "google-sub", userId: second.id,
    })).rejects.toThrow();
    store.state.members.push({ ...member, id: "ambiguous" });
    await expect(adapter.createUser!({ email: member.email, emailVerified: null })).rejects.toThrow();
    expect(await adapter.getUserByEmail!(member.email)).toBeNull();
  });
  it("only redirects to this site's origin, including protocol-relative/backslash attacks", async () => {
    const { safeAuthRedirect } = await import("./auth");
    const credentialUrl = new URL("https://club.example.org/");
    credentialUrl.username = "test-user";
    for (const url of ["https://evil.example/path", "//evil.example/path", "/\\evil.example", "javascript:alert(1)", credentialUrl.href]) {
      expect(safeAuthRedirect(url, "https://club.example.org")).toBe("https://club.example.org");
    }
    expect(safeAuthRedirect("/leader?week=1", "https://club.example.org")).toBe("https://club.example.org/leader?week=1");
  });
  it("keeps Google available without SMTP and disables live auth when explicit settings are missing even in demo mode", async () => {
    vi.stubEnv("EMAIL_SERVER", "");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    const { getAuthAvailability, authOptions } = await import("./auth");
    expect(getAuthAvailability()).toEqual({ google: true, email: false });
    expect(authOptions.providers.map((provider) => provider.id)).toEqual(["google"]);
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(getAuthAvailability()).toEqual({ google: false, email: false });
    expect(await authOptions.callbacks!.signIn!(googleParams())).toBe(false);
    vi.stubEnv("NEXTAUTH_SECRET", "test-only-auth-secret");
    vi.stubEnv("NEXTAUTH_URL", "");
    expect(getAuthAvailability()).toEqual({ google: false, email: false });
  });
  it("does not log metadata containing magic links or credentials", async () => {
    const logger = (await options()).logger!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error!("PRIVATE_TOKEN_URL", { error: new Error("private metadata"), token: "private-token", url: "https://example.org/?token=private" });
    expect(spy).toHaveBeenCalledWith("Authentication request failed.");
    spy.mockRestore();
  });
});

describe("persistent verification adapter and locked gateway", () => {
  it("persists only token hashes in protected auth-only sheets and allows one concurrent redemption", async () => {
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    const results = await Promise.all(Array.from({ length: 8 }, () => adapter.useVerificationToken!({
      identifier: " RUNNER@EXAMPLE.ORG ", token: token().token,
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.expires).toBeInstanceOf(Date);
    const journal = store.sheets.get("AuthEmailRequests")!;
    expect(journal.protected && journal.hidden).toBe(true);
    expect(store.sheets.has("Members")).toBe(false);
  });
  it("does not replay after an acknowledgement failure following a durable consume", async () => {
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    store.state.failAfterConsume = true;
    await expect(adapter.useVerificationToken!({ identifier: member.email, token: token().token })).rejects.toThrow();
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token().token })).toBeNull();
  });
  it("rejects expired, replayed, wrong-address and deactivated tokens", async () => {
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    expect(await adapter.useVerificationToken!({ identifier: "other@example.org", token: token().token })).toBeNull();
    vi.advanceTimersByTime(15 * 60_000);
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token().token })).toBeNull();
    await adapter.createVerificationToken!(token("b"));
    store.state.members[0].active = false;
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token("b").token })).toBeNull();
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token("b").token })).toBeNull();
  });
  it("fails closed for invalid lifetimes, denied members and lookup outages", async () => {
    const adapter = sheetsAuthAdapter();
    await expect(adapter.createVerificationToken!({ ...token(), expires: new Date(Date.now() + 16 * 60_000) })).rejects.toThrow();
    store.state.failLookup = true;
    await adapter.createVerificationToken!(token());
    store.state.failLookup = false;
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token().token })).toBeNull();
    store.state.members = [];
    await adapter.createVerificationToken!(token("b"));
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token("b").token })).toBeNull();
  });
  it("rechecks live membership before an idempotent send permit and denies tokens issued while inactive", async () => {
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    store.state.members[0].active = false;
    expect(await store.dispatch("authPrepareEmail", { ...token() })).toEqual({ allowed: false });
    vi.advanceTimersByTime(60_000);
    await adapter.createVerificationToken!(token("b"));
    store.state.members[0].active = true;
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token("b").token })).toBeNull();
  });
  it("implements persistent user/account/session lifecycle without mutating membership", async () => {
    const adapter = sheetsAuthAdapter();
    const user = await adapter.createUser!({ email: member.email, emailVerified: null });
    expect(await adapter.updateUser!({ id: user.id, emailVerified: new Date() })).toMatchObject({ id: user.id, emailVerified: expect.any(Date) });
    const session = { sessionToken: "random-session", userId: user.id, expires: new Date(Date.now() + 3600_000) };
    await adapter.createSession!(session);
    expect(await adapter.getSessionAndUser!(session.sessionToken)).toMatchObject({ user: { id: user.id } });
    await adapter.updateSession!({ sessionToken: session.sessionToken, expires: new Date(Date.now() + 7200_000) });
    await adapter.deleteSession!(session.sessionToken);
    expect(await adapter.getSessionAndUser!(session.sessionToken)).toBeNull();
    const account = { provider: "google", type: "oauth" as const, providerAccountId: "subject", userId: user.id };
    await adapter.linkAccount!(account);
    await adapter.unlinkAccount!(account);
    expect(await adapter.getUserByAccount!(account)).toBeNull();
    await adapter.deleteUser!(user.id);
    expect(await adapter.getUser!(user.id)).toBeNull();
    expect(store.state.members).toEqual([member]);
  });
  it("normalizes trim/case without accepting comma-separated or ambiguous addresses", () => {
    expect(normalizeAuthEmail(" RUNNER@EXAMPLE.ORG ")).toBe(member.email);
    for (const email of ["runner@example.org,other@example.org", "runner@@example.org", "a b@example.org"]) {
      expect(() => normalizeAuthEmail(email)).toThrow();
    }
  });
});

describe("direct NextAuth email endpoints", () => {
  it("shares persistent cooldown with UI requests; parallel adapter/send cannot bypass it", async () => {
    const config = await options();
    const responses = await Promise.all(Array.from({ length: 4 }, () => requestEmail(config, member.email)));
    expect(new Set(responses.map((response) => response.redirect)).size).toBe(1);
    expect(responses[0].redirect).toContain("/api/auth/verify-request");
    const verifyPage = await AuthHandler({ options: config, req: { action: "verify-request", method: "GET" } });
    expect(verifyPage.redirect).toContain("/auth/check-inbox");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const entries = store.sheets.get("AuthEmailRequests")!.values.slice(1).map((row) => JSON.parse(String(row[1])));
    expect(entries).toHaveLength(4);
    expect(entries.filter((entry) => entry.allowed)).toHaveLength(1);
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    const raw = new URL(mail.text.split("\n")[2]).searchParams.get("token")!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(entries.every((entry) => entry.token !== raw)).toBe(true);
    vi.advanceTimersByTime(60_000);
    await requestEmail(config, member.email);
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    await requestEmail(config, member.email);
    expect(mocks.sendMail).toHaveBeenCalledTimes(2); // fifth prior request spent hourly budget
  });
  it("gives member, nonmember, denied and SMTP-failure requests the same public result", async () => {
    const config = await options();
    const eligible = await requestEmail(config, member.email);
    const denied = await requestEmail(config, "outsider@example.org");
    expect(denied.redirect).toBe(eligible.redirect);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const adapter = sheetsAuthAdapter();
    const deniedEntry = store.sheets.get("AuthEmailRequests")!.values
      .map((row) => { try { return JSON.parse(String(row[1])); } catch { return null; } })
      .find((entry) => entry?.identifier === "outsider@example.org");
    expect(await adapter.useVerificationToken!({ identifier: "outsider@example.org", token: deniedEntry.token })).toBeNull();
    vi.advanceTimersByTime(60_000);
    mocks.sendMail.mockRejectedValue(new Error("SMTP private credential"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await requestEmail(config, member.email);
    expect(failure.redirect).toBe(eligible.redirect);
    expect(spy).toHaveBeenCalledWith("Authentication email delivery unavailable.");
    spy.mockRestore();
    expect(emailProvider(config).maxAge).toBe(900);
  });
  it("a real magic-link callback yields a JWT session and a second redemption fails", async () => {
    const config = await options();
    await requestEmail(config, member.email);
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    const url = new URL(mail.text.split("\n")[2]);
    const params = Object.fromEntries(url.searchParams);
    const callback = async () => AuthHandler({
      options: config,
      req: {
        action: "callback", providerId: "email", method: "GET",
        query: params,
      },
    });
    const first = await callback();
    expect(first.redirect).toBe("https://club.example.org/");
    expect(first.cookies?.some((cookie) => cookie.name.includes("session-token"))).toBe(true);
    const replay = await callback();
    expect(replay.redirect).toContain("Verification");
  });
});
