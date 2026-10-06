import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteDescription } from "./route-description";

describe("route description links", () => {
  it("turns http and https URLs into safe external links and preserves punctuation", () => {
    const html = renderToStaticMarkup(createElement(RouteDescription, {
      text: "Meet here: https://maps.example/route. Backup: http://club.example/route!",
    }));
    expect(html).toContain('class="route-link" href="https://maps.example/route" title="https://maps.example/route" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('class="route-link" href="http://club.example/route" title="http://club.example/route" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("</a>.");
    expect(html).toContain("</a>!");
  });
  it("does not create links for non-web protocols", () => {
    const html = renderToStaticMarkup(createElement(RouteDescription, { text: "javascript:alert(1) file:///private/route" }));
    expect(html).not.toContain("<a ");
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain("file:///private/route");
  });
});