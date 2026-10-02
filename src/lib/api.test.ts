import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ executeMutation: vi.fn(), getPlatformSnapshot: vi.fn() }));
import { executeMutation, getPlatformSnapshot } from "./platform";
import { GatewayError } from "./gateway";
import { handleMutation } from "./api";

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const body = {
  operation: "book", requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
  runId: "w", groupId: "g", runVersion: 1, groupVersion: 1,
};
function request(value: unknown, origin = "https://club.example.com") {
  return new Request("https://club.example.com/api/platform", {
    method: "POST", headers: { origin }, body: typeof value === "string" ? value : JSON.stringify(value),
  });
}
describe("club mutation API", () => {
  it("rejects cross-origin requests and invalid JSON without reaching storage", async () => {
    expect((await handleMutation(request(body, "https://evil.example.com"))).status).toBe(403);
    expect((await handleMutation(request("{"))).status).toBe(400);
    expect(executeMutation).not.toHaveBeenCalled();
  });
  it("fails closed for malformed origin configuration", async () => {
    vi.stubEnv("NEXTAUTH_URL", "javascript:invalid");
    expect((await handleMutation(request(body, "null"))).status).toBe(403);
    vi.stubEnv("NEXTAUTH_URL", "");
    expect((await handleMutation(request(body))).status).toBe(403);
    expect(executeMutation).not.toHaveBeenCalled();
  });
  it("requires a retry ID and strips arbitrary actor fields", async () => {
    expect((await handleMutation(request({ ...body, requestId: undefined }))).status).toBe(400);
    vi.mocked(executeMutation).mockResolvedValue({} as never);
    expect((await handleMutation(request({ ...body, email: "admin@example.com", roles: ["admin"] }))).status).toBe(200);
    expect(executeMutation).toHaveBeenCalledWith(body);
  });
  it("never treats a failed service response as a successful booking", async () => {
    vi.mocked(executeMutation).mockRejectedValue(new Error("credentials"));
    const result = await handleMutation(request(body));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain("credentials");
  });
  it("includes refreshed authoritative state with stale-version conflicts", async () => {
    vi.mocked(executeMutation).mockRejectedValue(new GatewayError("Refresh", 409, "STALE_VERSION"));
    vi.mocked(getPlatformSnapshot).mockResolvedValue({ bookings: [] } as never);
    const result = await handleMutation(request(body));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "STALE_VERSION", data: { bookings: [] } });
  });
});
