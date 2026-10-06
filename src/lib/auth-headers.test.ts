import { expect, it } from "vitest";
import config from "../../next.config";

it("does not log or forward token-bearing authentication URLs", async () => {
  expect(config.logging).toEqual({ incomingRequests: false });
  const headers = await config.headers?.();
  expect(headers?.find((entry) => entry.source === "/api/auth/:path*")?.headers)
    .toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  expect(headers?.find((entry) => entry.source === "/api/auth/:path*")?.headers)
    .toContainEqual({ key: "Cache-Control", value: "no-store" });
});
