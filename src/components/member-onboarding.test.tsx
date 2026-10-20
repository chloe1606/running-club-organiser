import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { MemberOnboarding } from "./member-onboarding";

describe("member onboarding", () => {
  it("defaults new members to runner, sweeper and active with an invitation selected", () => {
    const snapshot = createDemoSnapshot();
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: false }));
    expect(html).toContain("Full name");
    expect(html).toContain('type="email"');
    expect(html).toMatch(/checked=""\/>Runner/);
    expect(html).toMatch(/checked=""\/>Sweeper/);
    expect(html).toMatch(/checked=""\/>Active/);
    expect(html).toMatch(/checked=""\/>Send account invitation/);
    expect(html.match(/checked=""/g)).toHaveLength(4);
    expect(html).toContain("Demo only: no invitation emails will be sent.");
    expect(html).not.toContain("memberId");
  });
  it("explains membership is saved before live invitations and duplicates are skipped", () => {
    const snapshot = { ...createDemoSnapshot(), demo: false, currentMemberId: "demo-admin" };
    const html = renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: false }));
    expect(html).toContain("Active membership is saved first.");
    expect(html).toContain("Existing Clerk accounts and pending invitations are skipped.");
  });
  it("hides onboarding for runners and disables fields during a save", () => {
    const snapshot = createDemoSnapshot();
    snapshot.currentMemberId = "demo-runner";
    expect(renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: false }))).toBe("");
    snapshot.currentMemberId = "demo-admin";
    expect(renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: true }))).toContain('<fieldset disabled=""');
  });
});