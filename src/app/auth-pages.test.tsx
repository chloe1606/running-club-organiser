import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ isSignedIn: false, loading: false }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isSignedIn: authState.isSignedIn }),
  SignIn: ({ appearance, fallback }: { appearance: { elements: { headerTitle: React.CSSProperties } }; fallback: React.ReactNode }) =>
    authState.loading ? fallback : <div><h1 style={appearance.elements.headerTitle}>Clerk sign-in</h1></div>,
  SignUp: () => <div>Clerk account setup</div>,
}));
vi.mock("@/components/club-brand", () => import("../components/club-brand"));
vi.mock("@/components/club-sign-in", () => import("../components/club-sign-in"));
vi.mock("@/components/running-loader", () => import("../components/running-loader"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`Redirect: ${url}`); }),
}));
import SignInPage from "./sign-in/[[...sign-in]]/page";
import SignUpPage from "./sign-up/[[...sign-up]]/page";
import LegacySignInPage from "./auth/signin/page";
import LegacyCheckInboxPage from "./auth/check-inbox/page";
import Loading from "./loading";

beforeEach(() => {
  authState.isSignedIn = false; authState.loading = false;
  vi.stubGlobal("React", React); vi.stubEnv("CLUB_DEMO_MODE", "false");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Clerk authentication pages", () => {
  it("offers password login rather than Google or magic links", () => {
    const html = renderToStaticMarkup(createElement(SignInPage));
    expect(html).toContain("Clerk sign-in");
    expect(html).toContain('style="font-size:1.25rem;line-height:1.4"');
    expect(html).toContain("username or email and password");
    expect(html).not.toContain("Google");
    expect(html).not.toContain("magic link");
    expect(html).toContain('data-signed-in="false"');
  });
  it("provides an accessible running icon for the form's busy state", () => {
    const html = renderToStaticMarkup(createElement(SignInPage));
    expect(html).toContain("Signing you in...");
    expect(html).toContain('role="status"');
    expect(html).toContain('class="running-loader-icon"');
    expect(html).toContain('aria-hidden="true"');
  });
  it("shows the runner while Clerk loads and after sign-in succeeds", () => {
    authState.loading = true;
    expect(renderToStaticMarkup(createElement(SignInPage))).toContain("Loading sign-in...");
    authState.loading = false;
    authState.isSignedIn = true;
    expect(renderToStaticMarkup(createElement(SignInPage))).toContain("Loading your club runs...");
  });
  it("uses the runner while the destination page loads", () => {
    const html = renderToStaticMarkup(createElement(Loading));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading your club runs...");
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
