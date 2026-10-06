import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import vm from "node:vm";
import type { NextAuthOptions } from "next-auth";
import type { VerificationToken } from "next-auth/adapters";
import type { EmailConfig } from "next-auth/providers/email";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { normalizeAuthEmail, sheetsAuthAdapter } from "./auth-adapter";

const mocks = vi.hoisted(() => ({
  mutateSheet: vi.fn(), member: vi.fn(), sendMail: vi.fn(), close: vi.fn(), transport: vi.fn(),
}));
vi.mock("./gateway", () => ({ mutateSheet: mocks.mutateSheet }));
vi.mock("./sheets", () => ({ findActiveMemberByEmail: mocks.member }));
vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => {
    mocks.transport(options);
    return { sendMail: mocks.sendMail, close: mocks.close };
  },
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
    maxRows = 1000;
    getRange(row: number, column: number, height = 1, width = 1) {
      if (row + height - 1 > this.maxRows) throw new Error("Range exceeds sheet grid.");
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
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(after: number, count: number) {
      if (after > this.maxRows) throw new Error("Insertion exceeds sheet grid.");
      this.maxRows += count;
    }
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
  const state = { members: [{ ...member }], failLookup: false, failAfterConsume: false, spreadsheetId: "club-workbook" };
  const workbook = {
    getSheetByName: (name: string) => sheets.get(name),
    insertSheet: (name: string) => { const sheet = new Sheet(); sheets.set(name, sheet); return sheet; },
  };
  const spreadsheetApp = {
    ProtectionType: { SHEET: "SHEET" }, flush() {},
    getActiveSpreadsheet: () => null,
    openById: vi.fn((id: string) => {
      if (id !== "club-workbook") throw new Error("Unexpected workbook.");
      return workbook;
    }),
  };
  const context = vm.createContext({
    Date, console,
    SpreadsheetApp: spreadsheetApp,
    platformSpreadsheet_: () => {
      if (!state.spreadsheetId) throw new Error("Spreadsheet is not configured.");
      return spreadsheetApp.openById(state.spreadsheetId);
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
  return { dispatch, state, sheets, context, spreadsheetApp };
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
    EMAIL_SERVER_HOST: "smtp-relay.brevo.com", EMAIL_SERVER_PORT: "587",
    EMAIL_SERVER_USER: "test-user", EMAIL_SERVER_PASSWORD: "test-password",
    EMAIL_FROM: "club@example.org",
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
  it("persists Google account identity without unused OAuth API credentials", async () => {
    const config = await options();
    const params = googleParams();
    expect(await config.callbacks!.signIn!({
      ...params,
      account: {
        ...params.account, access_token: "unused-access", refresh_token: "unused-refresh",
        id_token: "unused-id", expires_at: 123, scope: "email profile",
      },
    })).toBe(true);
    const row = store.sheets.get("AuthAccounts")!.values[1];
    expect(JSON.parse(String(row[1]))).toEqual({
      provider: "google", providerAccountId: "google-sub", type: "oauth", userId: member.id,
    });
    const sent = mocks.mutateSheet.mock.calls.find(([operation]) => operation === "authLinkAccount");
    expect(sent?.[1]).toEqual({ account: JSON.parse(String(row[1])) });
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
    vi.stubEnv("EMAIL_SERVER_HOST", "");
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
  it("requires verified TLS for production SMTP and rejects non-SMTP or option-bearing URLs", async () => {
    const { smtpTransportOptions, getAuthAvailability } = await import("./auth");
    expect(smtpTransportOptions("smtp://mail.example.org", true)).toMatchObject({
      secure: false, requireTLS: true, ignoreTLS: false, tls: { rejectUnauthorized: true },
      logger: false, debug: false,
    });
    expect(smtpTransportOptions("smtps://mail.example.org", true)).toMatchObject({
      secure: true, port: 465, tls: { rejectUnauthorized: true },
    });
    expect(smtpTransportOptions("smtp://localhost:1025", true).requireTLS).toBe(true);
    expect(smtpTransportOptions("smtp://localhost:1025", false).requireTLS).toBe(false);
    expect(smtpTransportOptions("smtp://mail.example.org", false).requireTLS).toBe(true);
    for (const server of ["https://mail.example.org", "file:///mail", "smtp://mail.example.org?ignoreTLS=true", "smtp://mail.example.org?tls.rejectUnauthorized=false"]) {
      expect(() => smtpTransportOptions(server, true)).toThrow();
    }
    vi.stubEnv("EMAIL_SERVER_PORT", "70000");
    expect(getAuthAvailability()).toEqual({ google: true, email: false });
  });
  it("builds the Brevo SMTP URL with safely encoded credentials", async () => {
    const { smtpServerUrl, getAuthAvailability } = await import("./auth");
    vi.stubEnv("EMAIL_SERVER_USER", "smtp user+tag@example.org");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "secret:/?#@% value");
    const server = smtpServerUrl();
    expect(server).not.toBeNull();
    const url = new URL(server!);
    expect(decodeURIComponent(url.username)).toBe("smtp user+tag@example.org");
    expect(decodeURIComponent(url.password)).toBe("secret:/?#@% value");
    expect(url.hostname).toBe("smtp-relay.brevo.com");
    expect(url.port).toBe("587");
    expect(getAuthAvailability().email).toBe(true);
  });
  it("does not transmit credentials or magic links when a production SMTP server cannot start TLS", async () => {
    vi.useRealTimers();
    const commands: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost SMTP test\r\n");
      socket.on("data", (data) => {
        for (const command of data.toString().trim().split("\r\n")) {
          commands.push(command);
          if (command.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (command.startsWith("STARTTLS")) socket.write("454 TLS unavailable\r\n");
          else if (command.startsWith("QUIT")) socket.end("221 Goodbye\r\n");
          else socket.write("502 Not supported\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP test listener unavailable.");
    const { smtpTransportOptions } = await import("./auth");
    const actualMailer = require("nodemailer") as typeof import("nodemailer");
    const transport = actualMailer.createTransport({
      ...smtpTransportOptions(`smtp://127.0.0.1:${address.port}`, true),
      auth: { user: "test-user", pass: "test-only-password" },
      connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000,
    });
    try {
      await expect(transport.sendMail({
        from: "club@example.org", to: member.email, text: "test-only-magic-link",
      })).rejects.toThrow();
      expect(commands.some((command) => command.startsWith("STARTTLS"))).toBe(true);
      expect(commands.some((command) => command.startsWith("AUTH") || command.startsWith("DATA") ||
        command.includes("test-only-magic-link"))).toBe(false);
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("does not log metadata containing magic links or credentials", async () => {
    const logger = (await options()).logger!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error!("PRIVATE_TOKEN_URL", { error: new Error("private metadata"), token: "private-token", url: "https://example.org/?token=private" });
    expect(spy).toHaveBeenCalledWith("Authentication request failed.");
    spy.mockRestore();
  });
  it.each(["UNAUTHORIZED", "WORKBOOK_MISMATCH", "NOT_CONFIGURED", "AUTH_UNAVAILABLE", "UNKNOWN_OPERATION", "UNAVAILABLE", "NON_JSON_RESPONSE", "INVALID_RESPONSE"])(
    "reports only the allowlisted gateway code %s for adapter failures in development", async (code) => {
      vi.stubEnv("NODE_ENV", "development");
      const logger = (await options()).logger!;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        logger.error!("adapter_error_getUserByAccount", Object.assign(new Error("private upstream message"), {
          code, token: "private-token", url: "https://example.org/?token=private",
        }));
        expect(spy.mock.calls).toEqual([[
          `Authentication request failed (adapter_error_getUserByAccount; gateway: ${code}).`,
        ]]);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it("redacts unknown adapter errors and validation details in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const logger = (await options()).logger!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error!("adapter_error_getUserByAccount", Object.assign(new Error("private email"), { code: "private-token" }));
      logger.error!("adapter_error_getUserByAccount", new ZodError([{
        code: "custom", path: ["private email"], message: "private record",
      }]));
      expect(spy.mock.calls).toEqual([
        ["Authentication request failed (adapter_error_getUserByAccount)."],
        ["Authentication request failed (adapter_error_getUserByAccount; invalid auth record)."],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps production adapter failures generic even for known gateway codes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const logger = (await options()).logger!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error!("adapter_error_getUserByAccount", Object.assign(new Error("private metadata"), { code: "UNAUTHORIZED" }));
      expect(spy.mock.calls).toEqual([["Authentication request failed."]]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("persistent verification adapter and locked gateway", () => {
  it("uses the trusted workbook helper in a web app with no active spreadsheet and fails closed without configuration", async () => {
    expect(store.spreadsheetApp.getActiveSpreadsheet()).toBeNull();
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    expect(store.spreadsheetApp.openById).toHaveBeenCalledWith("club-workbook");
    store.state.spreadsheetId = "";
    await expect(adapter.useVerificationToken!({ identifier: member.email, token: token().token })).rejects.toThrow();
  });
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
  it("expands a full authentication journal before atomically appending another token", async () => {
    const adapter = sheetsAuthAdapter();
    await adapter.createVerificationToken!(token());
    const journal = store.sheets.get("AuthEmailRequests")!;
    while (journal.values.length < 1000) {
      const hash = journal.values.length.toString(16).padStart(64, "0");
      journal.values.push([`token:${hash}`, JSON.stringify({
        identifier: "old@example.org", token: hash, expires: new Date(Date.now() - 3600_000).toISOString(),
        createdAt: Date.now() - 7200_000, allowed: false, consumed: null,
      })]);
    }
    vi.advanceTimersByTime(60_000);
    await adapter.createVerificationToken!(token("b"));
    expect(journal.getMaxRows()).toBe(1100);
    expect(journal.values).toHaveLength(1001);
    expect(await adapter.useVerificationToken!({ identifier: member.email, token: token("b").token })).not.toBeNull();
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
  it("keeps real NextAuth JWT session, CSRF and signout working with no configured providers", async () => {
    const config = { ...await options(), providers: [] };
    const { encode } = await import("next-auth/jwt");
    const jwt = await encode({
      secret: config.secret!, token: { sub: member.id, email: member.email, name: member.name },
      maxAge: 3600,
    });
    const sessionCookie = "__Secure-next-auth.session-token";
    const session = await AuthHandler({
      options: config, req: { action: "session", method: "GET", cookies: { [sessionCookie]: jwt } },
    });
    expect(session.body).toMatchObject({ user: { email: member.email } });
    const csrf = await AuthHandler({ options: config, req: { action: "csrf", method: "GET" } });
    const signout = await AuthHandler({
      options: config,
      req: {
        action: "signout", method: "POST",
        cookies: { ...Object.fromEntries(csrf.cookies!.map((cookie) => [cookie.name, cookie.value])), [sessionCookie]: jwt },
        body: { csrfToken: csrf.body!.csrfToken, callbackUrl: "/" },
      },
    });
    expect(signout.redirect).toBe("https://club.example.org/");
    expect(signout.cookies?.find((cookie) => cookie.name === sessionCookie)?.value).toBe("");
  });
  it("shares persistent cooldown with UI requests; parallel adapter/send cannot bypass it", async () => {
    const config = await options();
    const responses = await Promise.all(Array.from({ length: 4 }, () => requestEmail(config, member.email)));
    expect(new Set(responses.map((response) => response.redirect)).size).toBe(1);
    expect(responses[0].redirect).toContain("/api/auth/verify-request");
    const verifyPage = await AuthHandler({ options: config, req: { action: "verify-request", method: "GET" } });
    expect(verifyPage.redirect).toContain("/auth/check-inbox");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({
      secure: false, requireTLS: true, ignoreTLS: false, tls: { rejectUnauthorized: true },
    }));
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
