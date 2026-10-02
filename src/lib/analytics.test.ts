import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "./demo-data";
import { favouriteGroup, queuePosition, weeklyAnalytics } from "./analytics";

describe("attendance analytics", () => {
  it("never treats a confirmed booking as actual attendance", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const upcoming = weeklyAnalytics(snapshot).find(w => w.run.status === "published")!;
    expect(upcoming.confirmed).toBeGreaterThan(0);
    expect(upcoming.present).toBe(0);
    expect(upcoming.unknown).toBe(upcoming.confirmed);
    expect(upcoming.attendanceRate).toBeUndefined();
  });
  it("preserves unknown attendance and excludes it from the rate denominator", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const week = weeklyAnalytics(snapshot).find(w => w.run.status === "archived")!;
    expect(week.unknown).toBeGreaterThan(0);
    expect(week.present + week.absent + week.unknown).toBe(week.confirmed);
    expect(week.attendanceRate).toBe(Math.round(week.present / (week.present + week.absent) * 100));
  });
  it("chooses favourite from present attendance with deterministic numeric tie-breaking", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const first = snapshot.groups.find(g => g.number === 1)!;
    const second = snapshot.groups.find(g => g.number === 2)!;
    snapshot.attendance = [
      { id: "a", memberId: "runner", runId: first.runId, groupId: second.id, outcome: "present", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "b", memberId: "runner", runId: first.runId, groupId: first.id, outcome: "present", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "c", memberId: "runner", runId: first.runId, groupId: second.id, outcome: "absent", recordedAt: "2026-01-01T00:00:00Z" },
    ];
    expect(favouriteGroup(snapshot, "runner")).toBe(1);
    expect(favouriteGroup(snapshot, "never-attended")).toBeUndefined();
  });
  it("orders a queue by booking time then stable booking ID", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const group = snapshot.groups[2];
    const queue = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted");
    expect(queuePosition(snapshot, group.id, queue[0].memberId)).toBe(1);
    queue.forEach(b => { b.bookedAt = "2026-01-01T00:00:00Z"; });
    expect(queuePosition(snapshot, group.id, queue.sort((a, b) => a.id.localeCompare(b.id))[0].memberId)).toBe(1);
    expect(queuePosition(snapshot, group.id, "not-queued")).toBeUndefined();
  });
});
