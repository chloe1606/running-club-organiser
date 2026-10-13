import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({ get: () => undefined }) }));
vi.mock("./auth", () => ({ authOptions: {} }));
vi.mock("./sheets", () => ({ findActiveMemberByEmail: vi.fn() }));
vi.mock("./gateway", async () => {
  const actual = await vi.importActual("./gateway");
  return { ...actual, mutateSheet: vi.fn() };
});
vi.mock("./demo-store", () => ({ getDemoSnapshot: vi.fn(), mutateDemo: vi.fn() }));

import { getServerSession } from "next-auth";
import { findActiveMemberByEmail } from "./sheets";
import { GatewayError, mutateSheet } from "./gateway";
import { getDemoSnapshot } from "./demo-store";
import { executeMutation, getPlatformSnapshot, previewWeeklyLeaderImport } from "./platform";

const mutation = {
  operation: "cancelRun" as const, requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
  runId: "w", runVersion: 1, cancellationReason: "Weather warning",
};
const member = { memberId: "m", email: "runner@example.com", displayName: "Runner", roles: "runner", active: "TRUE" as const, version: 1 };
beforeEach(() => { vi.stubEnv("CLUB_DEMO_MODE", "false"); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("server identity and role boundary", () => {
  it("denies member creation for runners before reaching the gateway", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    await expect(executeMutation({ operation: "addMember", requestId: mutation.requestId, memberEmail: "new@example.com", name: "New Runner", roles: ["runner"], active: true })).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });

  it("requires active admin membership for previews and never trusts a browser actor", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    await expect(previewWeeklyLeaderImport()).rejects.toMatchObject({ status: 401 });
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(undefined);
    await expect(previewWeeklyLeaderImport()).rejects.toMatchObject({ status: 403 });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    await expect(previewWeeklyLeaderImport()).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });

  it("returns only the typed names-only preview and rejects malformed gateway results", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue({ ...member, roles: "runner, admin" });
    const preview = { fingerprint: "a".repeat(64), unchanged: 1, errors: [], changes: [{ row: 2, date: "2026-10-13", groupNumber: 2, previousLeaderName: "Alex Smith", leaderName: "Taylor Jones" }] };
    vi.mocked(mutateSheet).mockResolvedValue({ ...preview, email: "private@example.org", secret: "private-secret", changes: [{ ...preview.changes[0], email: "private@example.org" }] });
    expect(await previewWeeklyLeaderImport()).toEqual(preview);
    expect(mutateSheet).toHaveBeenCalledWith("previewWeeklyLeaders", { email: member.email });
    vi.mocked(mutateSheet).mockResolvedValue({ fingerprint: "invalid" });
    await expect(previewWeeklyLeaderImport()).rejects.toMatchObject({ status: 502, code: "INVALID_SCHEMA" });
  });

  it("translates stale import fingerprints to a refreshable conflict", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue({ ...member, roles: "admin" });
    vi.mocked(mutateSheet).mockRejectedValue(new GatewayError("Preview again.", 400, "STALE_IMPORT"));
    await expect(executeMutation({ operation: "importWeeklyLeaders", requestId: mutation.requestId, expectedImportFingerprint: "a".repeat(64) })).rejects.toMatchObject({ status: 409, code: "STALE_IMPORT" });
  });

  it("denies automation and week-time changes before contacting the gateway", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    await expect(executeMutation({ operation: "updateWeeklyAutomation", requestId: mutation.requestId, configVersion: 1, enabled: true, publishTime: "18:00" })).rejects.toMatchObject({ status: 403 });
    await expect(executeMutation({ operation: "updateWeekTime", requestId: mutation.requestId, runId: "w", runVersion: 1, startTime: "20:00" })).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });
  it("denies weekly leader imports for non-admins and in demo mode", async () => {
    const intent = { operation: "importWeeklyLeaders" as const, requestId: mutation.requestId, expectedImportFingerprint: "a".repeat(64) };
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    await expect(executeMutation(intent)).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
    vi.stubEnv("CLUB_DEMO_MODE", "true");
    await expect(executeMutation(intent)).rejects.toThrow("unavailable in demo mode");
    expect(mutateSheet).not.toHaveBeenCalled();
  });
  it("requires a live session before a mutation", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    await expect(executeMutation(mutation)).rejects.toMatchObject({ status: 401 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });
  it("denies a deactivated existing session", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(undefined);
    await expect(executeMutation(mutation)).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });
  it("denies runner administration server-side", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    await expect(executeMutation(mutation)).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).not.toHaveBeenCalled();
  });
  it.each(["updateRoute", "assignSweeper", "recordAttendance"])("denies %s for an unassigned leader", async (operation) => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: member.email }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue({ ...member, roles: "runner,leader" });
    vi.mocked(mutateSheet).mockResolvedValue({
      weeks: [], groups: [], bookings: [], members: [], attendance: [], audit: [], demo: false,
      config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
    });
    await expect(executeMutation({
      operation, requestId: mutation.requestId, runId: "w", groupId: "g", runVersion: 1, groupVersion: 1,
    } as never)).rejects.toMatchObject({ status: 403 });
    expect(mutateSheet).toHaveBeenCalledTimes(1);
    expect(mutateSheet).toHaveBeenCalledWith("snapshot", { email: member.email });
  });
  it("does not silently substitute demo after live service failure", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(mutateSheet).mockRejectedValue(new Error("unavailable"));
    await expect(getPlatformSnapshot()).rejects.toThrow("unavailable");
    expect(getDemoSnapshot).not.toHaveBeenCalled();
  });
  it("rejects malformed live workbook responses", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(mutateSheet).mockResolvedValue({ demo: true });
    await expect(getPlatformSnapshot()).rejects.toMatchObject({ status: 502, code: "INVALID_SCHEMA" });
  });
  it("uses the session's trusted actor and returns authoritative live state after booking", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: "RUNNER@example.com" }, expires: "" });
    vi.mocked(findActiveMemberByEmail).mockResolvedValue(member);
    const snapshot = {
      weeks: [{ id: "w", startsAt: "2026-10-06T17:30:00Z", bookingOpensAt: "2026-10-02T17:00:00Z", bookingClosesAt: "2026-10-06T16:30:00Z", status: "published", version: 2 }],
      groups: Array.from({ length: 13 }, (_, index) => ({ id: `g${index + 1}`, runId: "w", number: index + 1, paceLabel: "DEMO", capacity: 19, version: 2 })),
      bookings: [{ id: "b", runId: "w", groupId: "g1", memberId: "m", source: "member", status: "confirmed", bookedAt: "2026-10-02T17:00:00Z", version: 1 }],
      members: [{ id: "m", email: member.email, name: member.displayName, roles: ["runner"], active: true, version: 1 }],
      attendance: [], audit: [], demo: false,
      config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
    };
    vi.mocked(mutateSheet).mockResolvedValueOnce({ status: "confirmed" }).mockResolvedValueOnce(snapshot);
    const intent = { operation: "book" as const, requestId: mutation.requestId, runId: "w", groupId: "g1", runVersion: 1, groupVersion: 1 };
    const result = await executeMutation(intent);
    expect(mutateSheet).toHaveBeenNthCalledWith(1, "book", { ...intent, email: member.email });
    expect(result.currentMemberId).toBe("m");
    expect(result.bookings[0].status).toBe("confirmed");
    expect(result.weeks[0].version).toBe(2);
  });
});
