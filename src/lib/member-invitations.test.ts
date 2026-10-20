import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "./demo-data";

const clerk = vi.hoisted(() => ({
  getUserList: vi.fn(), getInvitationList: vi.fn(), createInvitation: vi.fn(), client: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: clerk.client,
}));
vi.mock("./platform", () => ({ getPlatformSnapshot: vi.fn() }));

import { getPlatformSnapshot } from "./platform";
import { inviteClubMember } from "./member-invitations";

function snapshot() {
  const data = { ...createDemoSnapshot(), demo: false, currentMemberId: "demo-admin" };
  data.members.push({ id: "new-member", name: "New Runner", email: " NEW@example.org ", roles: ["runner"], active: true, version: 1 });
  return data;
}
beforeEach(() => {
  vi.stubEnv("CLUB_DEMO_MODE", "false");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_mock");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_mock");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.mocked(getPlatformSnapshot).mockResolvedValue(snapshot());
  clerk.client.mockResolvedValue({ users: { getUserList: clerk.getUserList }, invitations: {
    getInvitationList: clerk.getInvitationList, createInvitation: clerk.createInvitation,
  } });
  clerk.getUserList.mockResolvedValue({ data: [], totalCount: 0 });
  clerk.getInvitationList.mockResolvedValue({ data: [], totalCount: 0 });
  clerk.createInvitation.mockResolvedValue({});
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("member invitations", () => {
  it("invites the saved roster email to this site's signup without granting roles or returning tokens", async () => {
    expect(await inviteClubMember("new-member")).toEqual({
      memberId: "new-member", status: "sent", message: "Invitation sent to new@example.org.",
    });
    expect(clerk.getUserList).toHaveBeenCalledWith({ emailAddress: ["new@example.org"], limit: 1 });
    expect(clerk.createInvitation).toHaveBeenCalledWith({
      emailAddress: "new@example.org", redirectUrl: "http://localhost:3000/sign-up", notify: true, ignoreExisting: false,
    });
  });
  it.each(["signed-out", "runner", "inactive-admin"])("rejects %s before contacting Clerk", async persona => {
    const data = snapshot();
    if (persona === "signed-out") data.currentMemberId = "";
    if (persona === "runner") data.currentMemberId = "demo-runner";
    if (persona === "inactive-admin") data.members.find(member => member.id === "demo-admin")!.active = false;
    vi.mocked(getPlatformSnapshot).mockResolvedValue(data);
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ status: persona === "runner" ? 403 : 401 });
    expect(clerk.client).not.toHaveBeenCalled();
  });
  it("rechecks target membership on every retry and never invites inactive or missing members", async () => {
    const data = snapshot();
    data.members.find(member => member.id === "new-member")!.active = false;
    vi.mocked(getPlatformSnapshot).mockResolvedValue(data);
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ status: 400 });
    await expect(inviteClubMember("missing")).rejects.toMatchObject({ status: 404 });
    expect(clerk.client).not.toHaveBeenCalled();
  });
  it("simulates demo invitations without credentials or Clerk calls", async () => {
    vi.mocked(getPlatformSnapshot).mockResolvedValue({ ...snapshot(), demo: true });
    vi.stubEnv("CLERK_SECRET_KEY", "");
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "demo" });
    expect(clerk.client).not.toHaveBeenCalled();
  });
  it("skips existing accounts", async () => {
    clerk.getUserList.mockResolvedValue({ data: [{ id: "existing-user" }], totalCount: 1 });
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "registered" });
    expect(clerk.getInvitationList).not.toHaveBeenCalled();
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });
  it("checks exact emails across all pending-invitation pages before sending", async () => {
    clerk.getInvitationList.mockResolvedValueOnce({
      data: [{ emailAddress: "not-new@example.org", status: "pending" }], totalCount: 2,
    }).mockResolvedValueOnce({
      data: [{ emailAddress: "NEW@example.org", status: "pending" }], totalCount: 2,
    });
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "pending" });
    expect(clerk.getInvitationList).toHaveBeenLastCalledWith({ query: "new@example.org", status: "pending", limit: 100, offset: 1 });
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });
  it("does not treat partial email matches, expired or revoked invitations as valid pending invitations", async () => {
    clerk.getInvitationList.mockResolvedValue({ data: [
      { emailAddress: "not-new@example.org", status: "pending" },
      { emailAddress: "new@example.org", status: "expired" },
      { emailAddress: "new@example.org", status: "revoked" },
    ], totalCount: 3 });
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "sent" });
  });
  it("fails explicitly when invitation pagination is incomplete", async () => {
    clerk.getInvitationList.mockResolvedValue({ data: [], totalCount: 1 });
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ code: "INVITATION_LOOKUP" });
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });
  it("checks Clerk again after an uncertain send and does not send a duplicate on retry", async () => {
    clerk.createInvitation.mockRejectedValueOnce(new Error("network timeout"));
    await expect(inviteClubMember("new-member")).rejects.toThrow("network timeout");
    clerk.getInvitationList.mockResolvedValue({ data: [{ emailAddress: "new@example.org", status: "pending" }], totalCount: 1 });
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "pending" });
    expect(clerk.createInvitation).toHaveBeenCalledOnce();
  });
  it.each(["", "not-a-url", "ftp://club.example.org", "https://user:password@club.example.org"])(
    "rejects invalid APP_URL %s before contacting Clerk", async url => {
      vi.stubEnv("APP_URL", url);
      await expect(inviteClubMember("new-member")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(clerk.client).not.toHaveBeenCalled();
    },
  );
  it("rejects mismatched key environments", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_mock");
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(clerk.client).not.toHaveBeenCalled();
  });
  it.each([
    { mode: "development", url: "https://club.example.org", vercel: "" },
    { mode: "production", url: "http://localhost:3000", vercel: "" },
    { mode: "production", url: "https://club.example.org", vercel: "preview" },
    { mode: "production", url: "http://club.example.org", vercel: "" },
  ])("blocks live invitations outside HTTPS production: %j", async ({ mode, url, vercel }) => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_mock");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_live_mock");
    vi.stubEnv("APP_URL", url);
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("VERCEL_ENV", vercel);
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ code: "INVITATION_ENVIRONMENT" });
    expect(clerk.client).not.toHaveBeenCalled();
  });
  it("uses live keys and the canonical signup URL on production", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_mock");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_live_mock");
    vi.stubEnv("APP_URL", "https://club.example.org/");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await inviteClubMember("new-member")).toMatchObject({ status: "sent" });
    expect(clerk.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ redirectUrl: "https://club.example.org/sign-up" }));
  });
  it("blocks development-key invitations on Vercel production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(inviteClubMember("new-member")).rejects.toMatchObject({ code: "INVITATION_ENVIRONMENT" });
  });
  it("propagates lookup failures rather than sending anyway", async () => {
    clerk.getUserList.mockRejectedValue(new Error("Clerk unavailable"));
    await expect(inviteClubMember("new-member")).rejects.toThrow("Clerk unavailable");
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });
});
