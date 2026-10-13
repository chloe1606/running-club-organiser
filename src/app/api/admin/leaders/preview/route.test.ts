import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../../lib/platform", () => ({ previewWeeklyLeaderImport: vi.fn() }));
import { previewWeeklyLeaderImport } from "../../../../../lib/platform";
import { GatewayError } from "../../../../../lib/gateway";
import { POST } from "./route";

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
function request(origin = "https://club.example.com") {
  return new Request("https://club.example.com/api/admin/leaders/preview", { method: "POST", headers: { origin }, body: JSON.stringify({ email: "forged@example.org" }) });
}

describe("admin leader preview route", () => {
  it("denies cross-origin requests before invoking preview", async () => {
    expect((await POST(request("https://evil.example.com"))).status).toBe(403);
    expect(previewWeeklyLeaderImport).not.toHaveBeenCalled();
  });
  it("ignores supplied identity and returns an uncached typed preview", async () => {
    const data = { fingerprint: "a".repeat(64), changes: [], errors: [], unchanged: 1 };
    vi.mocked(previewWeeklyLeaderImport).mockResolvedValue(data);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ data });
    expect(previewWeeklyLeaderImport).toHaveBeenCalledWith();
  });
  it("preserves auth denials and masks unexpected upstream secrets", async () => {
    vi.mocked(previewWeeklyLeaderImport).mockRejectedValue(new GatewayError("Administrator access required.", 403, "FORBIDDEN"));
    expect((await POST(request())).status).toBe(403);
    vi.mocked(previewWeeklyLeaderImport).mockRejectedValue(new Error("private-secret"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-secret");
  });
});