import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ executeMutation: vi.fn(), getPlatformSnapshot: vi.fn() }));
vi.mock("./member-invitations", () => ({ inviteClubMember: vi.fn() }));
import { executeMutation, getPlatformSnapshot } from "./platform";
import { inviteClubMember } from "./member-invitations";
import { GatewayError } from "./gateway";
import { handleMutation } from "./api";
import { createDemoSnapshot } from "./demo-data";

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
    vi.stubEnv("APP_URL", "javascript:invalid");
    expect((await handleMutation(request(body, "null"))).status).toBe(403);
    vi.stubEnv("APP_URL", "");
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
  const newMember = { operation: "addMember", requestId: body.requestId, memberEmail: "new@example.org", name: "New Runner",
    roles: ["runner"], active: true, sendInvitation: true };
  function savedMembership() {
    const data = createDemoSnapshot();
    data.members.push({ id: "saved-id", name: newMember.name, email: newMember.memberEmail, roles: ["runner"], active: true, version: 1 });
    vi.mocked(executeMutation).mockResolvedValue(data);
    return data;
  }
  it("invites only after membership has been saved, using its server-assigned ID", async () => {
    const data = savedMembership();
    const invitation = { memberId: "saved-id", status: "sent" as const, message: "Invitation sent." };
    vi.mocked(inviteClubMember).mockImplementation(async memberId => {
      expect(executeMutation).toHaveBeenCalledOnce();
      expect(memberId).toBe("saved-id");
      return invitation;
    });
    const response = await handleMutation(request({ ...newMember, memberId: "forged" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data, invitation });
  });
  it("does not invite when the membership save fails", async () => {
    vi.mocked(executeMutation).mockRejectedValue(new GatewayError("Save failed", 503));
    expect((await handleMutation(request(newMember))).status).toBe(503);
    expect(inviteClubMember).not.toHaveBeenCalled();
  });
  it.each([{ sendInvitation: false }, { active: false }, { sendInvitation: undefined }])(
    "does not invite opted-out, inactive or legacy requests: %j", async overrides => {
      savedMembership();
      const response = await handleMutation(request({ ...newMember, ...overrides }));
      expect(response.status).toBe(200);
      expect(inviteClubMember).not.toHaveBeenCalled();
      expect((await response.json()).invitation).toBeUndefined();
    },
  );
  it("keeps saved membership and explicitly reports invitation failure without leaking provider details", async () => {
    const data = savedMembership();
    vi.mocked(inviteClubMember).mockRejectedValue(new Error("sensitive provider details"));
    const response = await handleMutation(request(newMember));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toEqual(data);
    expect(result.invitation).toMatchObject({ memberId: "saved-id", status: "failed" });
    expect(JSON.stringify(result)).not.toContain("sensitive provider details");
    expect(executeMutation).toHaveBeenCalledOnce();
  });
  it("surfaces actionable invitation configuration errors separately from the saved membership", async () => {
    savedMembership();
    vi.mocked(inviteClubMember).mockRejectedValue(new GatewayError("Set APP_URL before inviting.", 503, "NOT_CONFIGURED"));
    const response = await handleMutation(request(newMember));
    expect((await response.json()).invitation).toMatchObject({ status: "failed", message: "Set APP_URL before inviting." });
  });
});
