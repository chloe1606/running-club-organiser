import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavingButton } from "./saving-button";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("saving button", () => {
  it("keeps the normal label while idle", () => {
    const html = renderToStaticMarkup(createElement(SavingButton, { savingLabel: "Adding location..." }, "Add location"));
    expect(html).toContain(">Add location</button>");
    expect(html).not.toContain("saving-spinner");
    expect(html).not.toContain("aria-busy");
  });
  it("announces saving and disables repeat clicks with a decorative spinner", () => {
    const html = renderToStaticMarkup(createElement(SavingButton, { savingLabel: "Adding member...", busy: true }, "Add member"));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="saving-spinner" aria-hidden="true"');
    expect(html).toContain("Adding member...");
    expect(html).not.toContain(">Add member</button>");
  });
});
