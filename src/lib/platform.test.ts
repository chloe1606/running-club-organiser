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
import { mutateSheet } from "./gateway";
import { getDemoSnapshot } from "./demo-store";
import { executeMutation, getPlatformSnapshot } from "./platform";

const mutation = {
  operation: "cancelRun" as const, requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
  runId: "w", runVersion: 1, cancellationReason: "Weather warning",
};
const member = { memberId: "m", email: "runner@example.com", displayName: "Runner", roles: "runner", active: "TRUE" as const, version: 1 };
beforeEach(() => { vi.stubEnv("CLUB_DEMO_MODE", "false"); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("server identity and role boundary", () => {
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
});
