import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ proxyUrl, children }: { proxyUrl: string; children: React.ReactNode }) =>
    <div data-clerk-proxy-url={proxyUrl}>{children}</div>,
}));
import RootLayout from "./layout";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("routes browser Clerk requests through the same-origin proxy", () => {
  vi.stubEnv("CLUB_DEMO_MODE", "false");
  const html = renderToStaticMarkup(createElement(RootLayout, { children: "Club content" }));
  expect(html).toContain('data-clerk-proxy-url="/__clerk"');
  expect(html).toContain("Club content");
});

it("does not load Clerk in an explicit synthetic demo", () => {
  vi.stubEnv("CLUB_DEMO_MODE", "true");
  const html = renderToStaticMarkup(createElement(RootLayout, { children: "Demo content" }));
  expect(html).not.toContain("data-clerk-proxy-url");
  expect(html).toContain("Demo content");
});
