import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const middleware = vi.hoisted(() => vi.fn(() => new Response("Clerk checked")));
const options = vi.hoisted(() => ({ frontendApiProxy: { enabled: false } }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (configuration: typeof options) => {
    Object.assign(options, configuration);
    return middleware;
  },
}));
import proxy, { config } from "./proxy";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Clerk proxy boundary", () => {
  it("enables the built-in Frontend API proxy and matches its static asset paths", async () => {
    expect(options.frontendApiProxy.enabled).toBe(true);
    expect(config.matcher).toContain("/__clerk/(.*)");
    vi.stubEnv("CLUB_DEMO_MODE", "false");
    const request = new NextRequest("http://localhost:3000/__clerk/npm/@clerk/clerk-js/dist/clerk.browser.js");
    await proxy(request, {} as NextFetchEvent);
    expect(middleware).toHaveBeenCalledWith(request, {});
  });
  it("uses Clerk for normal pages and APIs", async () => {
    vi.stubEnv("CLUB_DEMO_MODE", "false");
    const request = new NextRequest("http://localhost:3000/api/platform");
    const response = await proxy(request, {} as NextFetchEvent);
    expect(await response?.text()).toBe("Clerk checked");
    expect(middleware).toHaveBeenCalledWith(request, {});
    expect(config.matcher).toContain("/(api|trpc)(.*)");
  });
  it("bypasses Clerk only for explicitly enabled synthetic demos", async () => {
    vi.stubEnv("CLUB_DEMO_MODE", "true");
    const response = await proxy(new NextRequest("http://localhost:3000/"), {} as NextFetchEvent);
    expect(response?.headers.get("x-middleware-next")).toBe("1");
    expect(middleware).not.toHaveBeenCalled();
  });
});
