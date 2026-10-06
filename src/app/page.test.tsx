import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/components/club-page", () => ({ ClubPage: () => null }));
vi.mock("./auth/signin/page", () => ({ default: () => null }));

import HomePage from "./page";
import { ClubPage } from "@/components/club-page";
import SignInPage from "./auth/signin/page";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubEnv("CLUB_DEMO_MODE", "false");
  mocks.session.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("home page sign-in entry", () => {
  it("shows sign-in for signed-out visitors and preserves callback/error parameters", async () => {
    const searchParams = Promise.resolve({ callbackUrl: "/leader", error: "OAuthCallback" });
    const page = await HomePage({ searchParams });
    expect(page.type).toBe(SignInPage);
    expect(page.props.searchParams).toBe(searchParams);
  });

  it("shows club runs for a signed-in member", async () => {
    mocks.session.mockResolvedValue({ user: { email: "runner@example.org" } });
    const page = await HomePage({ searchParams: Promise.resolve({}) });
    expect(page.type).toBe(ClubPage);
  });

  it("shows sign-in when a session has no member email", async () => {
    mocks.session.mockResolvedValue({ user: {} });
    const page = await HomePage({ searchParams: Promise.resolve({}) });
    expect(page.type).toBe(SignInPage);
  });

  it("preserves isolated demo previews without requesting a live session", async () => {
    vi.stubEnv("CLUB_DEMO_MODE", "true");
    const page = await HomePage({ searchParams: Promise.resolve({}) });
    expect(page.type).toBe(ClubPage);
    expect(mocks.session).not.toHaveBeenCalled();
  });
});