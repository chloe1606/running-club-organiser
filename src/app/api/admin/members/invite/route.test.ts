import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../../lib/member-invitations", () => ({ inviteClubMember: vi.fn() }));
import { inviteClubMember } from "../../../../../lib/member-invitations";
import { GatewayError } from "../../../../../lib/gateway";
import { POST } from "./route";

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
function request(body: string, origin = "https://club.example.org") {
  return new Request("https://club.example.org/api/admin/members/invite", {
    method: "POST", headers: { origin }, body,
  });
}
describe("invitation retry API", () => {
  it("rejects cross-origin, invalid and oversized requests before contacting Clerk", async () => {
    expect((await POST(request('{"memberId":"m"}', "https://evil.example.org"))).status).toBe(403);
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request("{}"))).status).toBe(400);
    expect((await POST(request(" ".repeat(1_001)))).status).toBe(413);
    expect(inviteClubMember).not.toHaveBeenCalled();
  });
  it("accepts only the saved member ID, not browser-supplied email or roles", async () => {
    const invitation = { memberId: "m", status: "pending" as const, message: "Already pending." };
    vi.mocked(inviteClubMember).mockResolvedValue(invitation);
    const response = await POST(request(JSON.stringify({ memberId: "m", email: "forged@example.org", roles: ["admin"] })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitation });
    expect(inviteClubMember).toHaveBeenCalledWith("m");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([401, 403, 400, 404])("preserves server authorization/membership failure %s", async status => {
    vi.mocked(inviteClubMember).mockRejectedValue(new GatewayError("Denied", status));
    expect((await POST(request('{"memberId":"m"}'))).status).toBe(status);
  });
  it("reports provider failure without leaking details", async () => {
    vi.mocked(inviteClubMember).mockRejectedValue(new Error("sensitive provider details"));
    const response = await POST(request('{"memberId":"m"}'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive provider details");
  });
});
