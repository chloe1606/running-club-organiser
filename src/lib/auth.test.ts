import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  auth: vi.fn(), currentUser: vi.fn(), updateUser: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: clerk.auth, currentUser: clerk.currentUser,
  clerkClient: async () => ({ users: { updateUser: clerk.updateUser } }),
}));
vi.mock("./sheets", () => ({ findActiveMemberByEmail: vi.fn() }));

import { getClubMember } from "./auth";
import { findActiveMemberByEmail } from "./sheets";

const member = { memberId: "club-member-1", email: "runner@example.org", displayName: "Runner",
  roles: "runner", active: "TRUE" as const, version: 1 };
function user(externalId: string | null = member.memberId) {
  return { id: "user_clerk", externalId, primaryEmailAddressId: "email_1",
    emailAddresses: [{ id: "email_1", emailAddress: " RUNNER@example.org ", verification: { status: "verified" } }] };
}
beforeEach(() => {
  clerk.auth.mockResolvedValue({ isAuthenticated: true, userId: "user_clerk" });
  clerk.currentUser.mockResolvedValue(user());
  vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
});
afterEach(() => vi.resetAllMocks());

describe("Clerk club identity", () => {
  it("keeps signed-out visitors public without looking up membership", async () => {
    clerk.auth.mockResolvedValue({ isAuthenticated: false, userId: null });
    expect(await getClubMember()).toBeUndefined();
    expect(clerk.currentUser).not.toHaveBeenCalled();
    expect(findActiveMemberByEmail).not.toHaveBeenCalled();
  });
  it("uses only a verified primary email and trusted club roles", async () => {
    expect(await getClubMember()).toEqual(member);
    expect(findActiveMemberByEmail).toHaveBeenCalledWith(member.email);
    expect(clerk.updateUser).not.toHaveBeenCalled();
  });
  it("binds new verified accounts to the existing stable member ID", async () => {
    clerk.currentUser.mockResolvedValue(user(null));
    expect(await getClubMember()).toEqual(member);
    expect(clerk.updateUser).toHaveBeenCalledWith("user_clerk", { externalId: member.memberId });
  });
  it("rejects unverified primary emails even when another email is verified", async () => {
    const account = user();
    account.emailAddresses[0].verification.status = "unverified";
    account.emailAddresses.push({ id: "other", emailAddress: member.email, verification: { status: "verified" } });
    clerk.currentUser.mockResolvedValue(account);
    await expect(getClubMember()).rejects.toMatchObject({ status: 403, code: "EMAIL_NOT_VERIFIED" });
    expect(findActiveMemberByEmail).not.toHaveBeenCalled();
  });
  it.each([null, { ...user(), id: "different-user" }, { ...user(), primaryEmailAddressId: null }])(
    "rejects missing or mismatched Clerk identity %j", async account => {
      clerk.currentUser.mockResolvedValue(account);
      await expect(getClubMember()).rejects.toMatchObject({ status: 403 });
      expect(findActiveMemberByEmail).not.toHaveBeenCalled();
    },
  );
  it("rejects nonmembers and deactivated members without provisioning access", async () => {
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(undefined);
    await expect(getClubMember()).rejects.toMatchObject({ status: 403 });
    expect(clerk.updateUser).not.toHaveBeenCalled();
  });
  it("does not allow email changes to switch an existing club identity", async () => {
    clerk.currentUser.mockResolvedValue(user("another-member"));
    await expect(getClubMember()).rejects.toMatchObject({ status: 403 });
    expect(clerk.updateUser).not.toHaveBeenCalled();
  });
  it("propagates provider and membership failures instead of treating them as signed out", async () => {
    clerk.currentUser.mockRejectedValue(new Error("Clerk unavailable"));
    await expect(getClubMember()).rejects.toThrow("Clerk unavailable");
    clerk.currentUser.mockResolvedValue(user());
    vi.mocked(findActiveMemberByEmail).mockRejectedValue(new Error("Sheets unavailable"));
    await expect(getClubMember()).rejects.toThrow("Sheets unavailable");
  });
  it("does not grant access if binding fails", async () => {
    clerk.currentUser.mockResolvedValue(user(null));
    clerk.updateUser.mockRejectedValue(new Error("Binding unavailable"));
    await expect(getClubMember()).rejects.toThrow("Binding unavailable");
  });
});
