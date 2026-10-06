import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  availability: { google: false, email: false }, configured: true, handler: vi.fn(),
}));
vi.mock("./auth", () => ({
  authOptions: {},
  getAuthAvailability: () => state.availability,
  isAuthSessionConfigured: () => state.configured,
}));
vi.mock("next-auth", () => ({ default: () => state.handler }));

import { GET, POST } from "../app/api/auth/[...nextauth]/route";

beforeEach(() => {
  state.availability = { google: false, email: false };
  state.configured = true;
  state.handler.mockReset().mockResolvedValue(new Response("NextAuth housekeeping", {
    status: 200, headers: { "Set-Cookie": "next-auth.session-token=; Max-Age=0" },
  }));
});

describe("auth route availability gate", () => {
  it.each(["signout", "csrf", "session", "providers", "error", "verify-request"])(
    "forwards %s to NextAuth with providers unavailable", async (action) => {
      const request = new NextRequest(`https://club.example.org/api/auth/${action}`);
      const context = { params: Promise.resolve({ nextauth: [action] }) };
      const response = await GET(request, context);
      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
      expect(state.handler).toHaveBeenCalledWith(request, context);
    },
  );
  it("forwards POST signout unchanged so NextAuth still enforces CSRF and clears cookies", async () => {
    const request = new NextRequest("https://club.example.org/api/auth/signout", {
      method: "POST", body: "csrfToken=test-only-csrf",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const context = { params: Promise.resolve({ nextauth: ["signout"] }) };
    expect((await POST(request, context)).status).toBe(200);
    expect(state.handler).toHaveBeenCalledWith(request, context);
    expect(await request.text()).toBe("csrfToken=test-only-csrf");
  });
  it.each([["signin"], ["signin", "google"], ["signin", "email"], ["callback", "google"], ["callback", "email"]])(
    "rejects provider-dependent request %j uniformly", async (...segments) => {
      const request = new NextRequest("https://club.example.org/api/auth/signin");
      const response = await GET(request, { params: Promise.resolve({ nextauth: segments }) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Authentication is not configured." });
      expect(state.handler).not.toHaveBeenCalled();
    },
  );
  it("allows Google while denying an unavailable email provider", async () => {
    state.availability.google = true;
    const request = new NextRequest("https://club.example.org/api/auth/signin");
    expect((await GET(request, { params: Promise.resolve({ nextauth: ["signin", "google"] }) })).status).toBe(200);
    expect((await GET(request, { params: Promise.resolve({ nextauth: ["callback", "email"] }) })).status).toBe(503);
    expect((await GET(request, { params: Promise.resolve({ nextauth: ["signin", "unknown"] }) })).status).toBe(503);
  });
  it("still requires the explicit session secret and canonical URL for housekeeping", async () => {
    state.configured = false;
    const request = new NextRequest("https://club.example.org/api/auth/signout");
    expect((await GET(request, { params: Promise.resolve({ nextauth: ["signout"] }) })).status).toBe(503);
    expect(state.handler).not.toHaveBeenCalled();
  });
});
