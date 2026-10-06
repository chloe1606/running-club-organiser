import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "./demo-data";
import { favouriteGroup, groupAnalytics, queuePosition, waitlistAnalytics, weeklyAnalytics } from "./analytics";

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
  it("compares booking capacity with actual attendance capacity without counting future attendance", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const snapshot = createDemoSnapshot(now);
    const metric = groupAnalytics(snapshot, now)[0];
    expect(metric.capacity).toBe(13 * 19);
    expect(metric.bookingUtilisation).toBe(Math.round(metric.confirmed / (13 * 19) * 100));
    expect(metric.attendanceUtilisation).toBe(Math.round(metric.present / (12 * 19) * 100));
    expect(metric.present).toBeLessThan(metric.confirmed);
  });
  it("uses recorded waitlist joins, promotions and saved peak queues, not current bookings", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const metrics = waitlistAnalytics(snapshot);
    expect(metrics.joins).toBeGreaterThan(metrics.promotions);
    expect(metrics.promotions).toBe(36);
    expect(metrics.peakQueue).toBe(4);
    expect(metrics.promotionRate).toBe(Math.round(metrics.promotions / metrics.joins * 100));
    snapshot.audit = [];
    expect(waitlistAnalytics(snapshot).peakQueue).toBeUndefined();
    expect(waitlistAnalytics(snapshot).promotionRate).toBeUndefined();
  });
  it("excludes cancelled weeks from favourite-group attendance", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    const cancelled = snapshot.weeks.find(w => snapshot.attendance.some(a => a.runId === w.id && a.memberId === "demo-runner" && a.outcome === "present"))!;
    snapshot.weeks.forEach(w => { w.status = "cancelled"; });
    expect(favouriteGroup(snapshot, "demo-runner")).toBeUndefined();
    cancelled.status = "archived";
    const actual = snapshot.attendance.find(a => a.runId === cancelled.id && a.memberId === "demo-runner" && a.outcome === "present")!;
    expect(favouriteGroup(snapshot, "demo-runner")).toBe(snapshot.groups.find(g => g.id === actual.groupId)!.number);
  });
  it("normalizes actual utilisation against available capacity, not the largest booked week", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const snapshot = createDemoSnapshot(now);
    const metric = weeklyAnalytics(snapshot, now).find(w => w.run.status === "archived")!;
    expect(metric.capacity).toBe(13 * 19);
    expect(metric.attendanceUtilisation).toBe(Math.round(metric.present / metric.capacity * 100));
    metric.run.status = "cancelled";
    expect(weeklyAnalytics(snapshot, now).find(w => w.run.id === metric.run.id)!.capacity).toBe(0);
  });
  it("keeps utilisation unknown when a completed week has no attendance records", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const snapshot = createDemoSnapshot(now);
    snapshot.attendance = [];
    const week = weeklyAnalytics(snapshot, now).find(w => w.run.status === "archived")!;
    expect(week.attendanceUtilisation).toBeUndefined();
    expect(week.attendanceRate).toBeUndefined();
    expect(week.unknown).toBe(week.confirmed);
    expect(groupAnalytics(snapshot, now).every(g => g.attendanceUtilisation === undefined)).toBe(true);
    expect(groupAnalytics(snapshot, now).every(g => g.attendanceUnknown > 0 && g.attendanceRecorded === 0)).toBe(true);
  });
  it("excludes cancelled and draft waitlist events from joins, promotions and peak queue", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-02T12:00:00Z"));
    snapshot.weeks.forEach(w => { w.status = "cancelled"; });
    snapshot.weeks[0].status = "draft";
    expect(waitlistAnalytics(snapshot)).toEqual({ joins: 0, promotions: 0, withdrawals: 0, peakQueue: undefined, promotionRate: undefined });
  });
});
