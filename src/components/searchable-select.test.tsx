import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelect } from "./searchable-select";

describe("searchable select", () => {
  it("keeps search hidden while closed and shows the selected label", () => {
    const html = renderToStaticMarkup(createElement(SearchableSelect, {
      label: "Runner",
      value: "runner-1",
      options: [{ value: "runner-1", label: "Taylor Example" }],
      placeholder: "Select runner",
      onChange: vi.fn(),
    }));
    expect(html).toContain("Taylor Example");
    expect(html).not.toContain("Type to filter");
    expect(html).not.toContain("role=\"listbox\"");
  });
});
