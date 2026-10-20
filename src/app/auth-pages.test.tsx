import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  SignIn: () => <div>Clerk sign-in</div>,
  SignUp: () => <div>Clerk account setup</div>,
}));
vi.mock("@/components/club-brand", () => import("../components/club-brand"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`Redirect: ${url}`); }),
}));
import SignInPage from "./sign-in/[[...sign-in]]/page";
import SignUpPage from "./sign-up/[[...sign-up]]/page";
import LegacySignInPage from "./auth/signin/page";
import LegacyCheckInboxPage from "./auth/check-inbox/page";

beforeEach(() => { vi.stubGlobal("React", React); vi.stubEnv("CLUB_DEMO_MODE", "false"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Clerk authentication pages", () => {
  it("offers password login rather than Google or magic links", () => {
    const html = renderToStaticMarkup(createElement(SignInPage));
    expect(html).toContain("Clerk sign-in");
    expect(html).toContain("username or email and password");
    expect(html).not.toContain("Google");
    expect(html).not.toContain("magic link");
  });
  it("explains that account setup needs an invitation and is not club membership", () => {
    const html = renderToStaticMarkup(createElement(SignUpPage));
    expect(html).toContain("Clerk account setup");
    expect(html).toContain("invitation");
    expect(html).toContain("does not create club membership");
  });
  it.each([LegacySignInPage, LegacyCheckInboxPage])("redirects legacy auth pages to Clerk", page => {
    expect(page).toThrow("Redirect: /sign-in");
  });
  it.each([SignInPage, SignUpPage])("keeps synthetic demo visitors out of real authentication", page => {
    vi.stubEnv("CLUB_DEMO_MODE", "true");
    expect(page).toThrow("Redirect: /");
  });
});
