import { describe, expect, it } from "vitest";
import { visibleSnapshot } from "./privacy";
import type { PlatformSnapshot } from "./platform-types";

const fixture: PlatformSnapshot = {
  config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
  demo: false,
  weeks: ["published", "archived", "draft"].map((status, index) => ({
    id: `w${index}`, status: status as "published" | "archived" | "draft", startsAt: "", bookingOpensAt: "", bookingClosesAt: "", version: 1,
  })),
  groups: [{ id: "g", runId: "w0", leaderId: "l", number: 1, paceLabel: "DEMO", capacity: 19, version: 1 }],
  members: ["r", "l", "a", "d"].map((id) => ({
    id, email: `${id}@example.com`, name: `Demo ${id}`, roles: [id === "a" ? "admin" : id === "l" ? "leader" : "runner"], active: id !== "d", version: 1,
  })),
  bookings: ["w0", "w1"].flatMap((runId) => ["r", "l"].map((memberId) => ({
    id: `${runId}-${memberId}`, runId, groupId: runId === "w0" ? "g" : "history", memberId,
    status: "confirmed" as const, source: "member" as const, bookedAt: "private", version: 1,
  }))),
  attendance: ["r", "l"].map((memberId) => ({ id: memberId, runId: "w1", groupId: "history", memberId, outcome: "present", recordedAt: "" })),
  audit: [{ id: "audit", runId: "w0", actorId: "a", action: "move", at: "", requestId: "id" }],
};

describe("server data minimization", () => {
  it("does not expose public rosters, private history, emails or drafts", () => {
    const result = visibleSnapshot(fixture);
    expect(result.members).toEqual([]);
    expect(result.attendance).toEqual([]);
    expect(result.audit).toEqual([]);
    expect(result.weeks).toHaveLength(2);
    expect(result.bookings).toHaveLength(2);
    expect(result.bookings.every((booking) => booking.memberId.startsWith("anonymous") && !booking.bookedAt)).toBe(true);
  });
  it("limits runner private history to their own", () => {
    const result = visibleSnapshot(fixture, "r");
    expect(result.attendance.map((record) => record.memberId)).toEqual(["r"]);
    expect(result.bookings.filter((booking) => booking.runId === "w1").map((booking) => booking.memberId)).toEqual(["r"]);
    expect(result.members.find((member) => member.id === "l")?.email).toBe("");
    expect(result.members.some((member) => member.id === "d")).toBe(false);
    expect(result.audit).toEqual([]);
  });
  it("treats deactivated identities as public, grants admin only trusted roles", () => {
    expect(visibleSnapshot(fixture, "d").members).toEqual([]);
    expect(visibleSnapshot(fixture, "a").audit).toHaveLength(1);
  });
});
