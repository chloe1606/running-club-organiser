import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { MemberOnboarding } from "./member-onboarding";

describe("member onboarding", () => {
  it("defaults new members to runner and active with no supplied member ID", () => {
    const snapshot = createDemoSnapshot();
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: false }));
    expect(html).toContain("Full name");
    expect(html).toContain('type="email"');
    expect(html).toMatch(/checked=""\/>Runner/);
    expect(html).toMatch(/checked=""\/>Active/);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).not.toContain("memberId");
  });
  it("hides onboarding for runners and disables fields during a save", () => {
    const snapshot = createDemoSnapshot();
    snapshot.currentMemberId = "demo-runner";
    expect(renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: false }))).toBe("");
    snapshot.currentMemberId = "demo-admin";
    expect(renderToStaticMarkup(createElement(MemberOnboarding, { snapshot, mutate: vi.fn(), pending: true }))).toContain('<fieldset disabled=""');
  });
});