import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/club-page", () => ({ ClubPage: () => null }));

import HomePage from "./page";
import { ClubPage } from "@/components/club-page";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubEnv("CLUB_DEMO_MODE", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public club runs page", () => {
  it("shows the public club runs page to signed-out visitors", () => {
    const page = HomePage();
    expect(page.type).toBe(ClubPage);
  });

  it("preserves isolated demo previews", () => {
    vi.stubEnv("CLUB_DEMO_MODE", "true");
    const page = HomePage();
    expect(page.type).toBe(ClubPage);
  });
});