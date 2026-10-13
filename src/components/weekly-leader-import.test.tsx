import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { WeeklyLeaderImport, WeeklyLeaderPreview } from "./weekly-leader-import";

describe("weekly leader import controls", () => {
  it("shows full-name assignments, unchanged count and all row errors", () => {
    const html = renderToStaticMarkup(createElement(WeeklyLeaderPreview, { preview: {
      fingerprint: "a".repeat(64), unchanged: 3,
      changes: [{ row: 2, date: "2026-10-13", groupNumber: 2, previousLeaderName: "Alex Smith", leaderName: "Taylor Jones" }],
      errors: [{ row: 4, code: "INVALID_DATE", message: "Invalid date" }, { row: 6, code: "INVALID_ASSIGNMENT", message: "Choose an active leader" }],
    } }));
    expect(html).toContain("Alex Smith"); expect(html).toContain("Taylor Jones");
    expect(html).toContain("3 unchanged"); expect(html).toContain("2 errors");
    expect(html).toContain("Row 4: Invalid date"); expect(html).toContain("Row 6: Choose an active leader");
    expect(html).not.toContain("@example"); expect(html).not.toContain("a".repeat(64));
  });
  it("requires a live admin and never renders apply before preview", () => {
    const snapshot = createDemoSnapshot();
    snapshot.currentMemberId = "demo-admin";
    const render = () => renderToStaticMarkup(createElement(WeeklyLeaderImport, { snapshot, mutate: vi.fn(), pending: false }));
    expect(render()).toBe("");
    snapshot.demo = false;
    expect(render()).toContain("Preview import");
    expect(render()).not.toContain("Apply leader changes");
    snapshot.currentMemberId = "demo-runner";
    expect(render()).toBe("");
  });
});