import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDemoSnapshot } from "./demo-data";
import { confirmedCount } from "./domain";
import { snapshotSchema } from "./platform-schema";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("CLUB_DEMO_MODE", "true");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function setup() {
  const { getDemoSnapshot, mutateDemo } = await import("./demo-store");
  const snapshot = getDemoSnapshot("admin");
  const run = snapshot.weeks.find(w => w.status === "published")!;
  const group = snapshot.groups.find(g => g.runId === run.id && g.number === 3)!;
  const payload = () => {
    const current = getDemoSnapshot("admin");
    return { requestId: randomUUID(), runId: run.id, runVersion: current.weeks.find(w => w.id === run.id)!.version,
      groupId: group.id, groupVersion: current.groups.find(g => g.id === group.id)!.version };
  };
  return { getDemoSnapshot, mutateDemo, snapshot, run, group, payload };
}

describe("isolated explicit demo", () => {
  it("refuses access unless CLUB_DEMO_MODE is exactly true", async () => {
    const { getDemoSnapshot, mutateDemo } = await import("./demo-store");
    vi.stubEnv("CLUB_DEMO_MODE", "false");
    expect(() => getDemoSnapshot()).toThrow("disabled");
    expect(() => mutateDemo("book", {})).toThrow("disabled");
  });
  it("provides valid unique synthetic references, 13 varied groups and 12 history weeks", () => {
    const snapshot = createDemoSnapshot(new Date());
    expect(snapshot.weeks).toHaveLength(13);
    expect(snapshot.groups.filter(g => g.runId === snapshot.weeks[0].id)).toHaveLength(13);
    const result = snapshotSchema.safeParse({ ...snapshot, demo: false });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(snapshot.members.every(m => m.email.endsWith("@example.test"))).toBe(true);
    expect(new Set(snapshot.groups.slice(0, 13).map(g => confirmedCount(g.id, snapshot.bookings))).size).toBeGreaterThan(5);
    expect(snapshot.groups.every(g => confirmedCount(g.id, snapshot.bookings) <= g.capacity)).toBe(true);
  });
  it("uses club-local Tuesday, including DST change, rather than a hard-coded week", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-23T12:00:00Z"));
    expect(snapshot.weeks[0].startsAt).toBe("2026-10-27T18:30:00.000Z");
    expect(snapshot.weeks[0].bookingClosesAt).toBe("2026-10-27T17:30:00.000Z");
  });
  it("returns independent copies and removes nonadmin emails and audit", async () => {
    const { getDemoSnapshot } = await setup();
    const runner = getDemoSnapshot();
    expect(runner.currentMemberId).toBe("demo-runner");
    expect(runner.members.every(m => m.email === "")).toBe(true);
    runner.groups[0].capacity = 1;
    expect(getDemoSnapshot().groups[0].capacity).toBe(19);
    expect(() => getDemoSnapshot("unknown")).toThrow("persona");
  });
  it("waitlists full groups, rejects duplicate bookings and calculates queue position", async () => {
    const { mutateDemo, payload, group } = await setup();
    const next = mutateDemo("book", payload());
    const booking = next.bookings.find(b => b.memberId === "demo-runner" && b.groupId === group.id)!;
    expect(booking.status).toBe("waitlisted");
    expect(() => mutateDemo("book", { ...payload() })).toThrow("already");
  });
  it("atomically switches groups, leaves and promotes the first queued runner", async () => {
    const { getDemoSnapshot, mutateDemo, payload, group, run } = await setup();
    mutateDemo("book", payload());
    const destination = getDemoSnapshot().groups.find(g => g.runId === run.id && g.number === 1)!;
    mutateDemo("switchGroup", { ...payload(), groupId: destination.id, groupVersion: destination.version });
    const active = getDemoSnapshot().bookings.filter(b => b.memberId === "demo-runner" && b.runId === run.id && b.status !== "cancelled");
    expect(active).toHaveLength(1); expect(active[0].groupId).toBe(destination.id);
    expect(getDemoSnapshot().bookings.find(b => b.memberId === "demo-runner" && b.groupId === group.id)!.status).toBe("cancelled");
    mutateDemo("leave", payload());
    expect(getDemoSnapshot().bookings.filter(b => b.memberId === "demo-runner" && b.runId === run.id && b.status !== "cancelled")).toHaveLength(0);
    const full = getDemoSnapshot("admin").groups.find(g => g.id === group.id)!;
    const queued = getDemoSnapshot("admin").bookings.filter(b => b.groupId === full.id && b.status === "waitlisted").sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))[0];
    const runner = getDemoSnapshot("admin").bookings.find(b => b.groupId === full.id && b.status === "confirmed" && b.source === "member")!;
    const dest = getDemoSnapshot("admin").groups.find(g => g.id === destination.id)!;
    mutateDemo("moveRunner", { ...payload(), groupId: dest.id, groupVersion: dest.version, memberId: runner.memberId }, "admin");
    expect(getDemoSnapshot("admin").bookings.find(b => b.id === queued.id)!.status).toBe("confirmed");
    expect(confirmedCount(full.id, getDemoSnapshot("admin").bookings)).toBe(full.capacity);
  });
  it("rejects stale versions without altering state and replays identical requests", async () => {
    const { getDemoSnapshot, mutateDemo, payload } = await setup();
    const request = payload();
    mutateDemo("book", request);
    const count = getDemoSnapshot().bookings.length;
    mutateDemo("book", request);
    expect(getDemoSnapshot().bookings).toHaveLength(count);
    expect(() => mutateDemo("leave", request)).toThrow("different action");
    expect(() => mutateDemo("book", { ...request, requestId: randomUUID() })).toThrow("changed");
    expect(getDemoSnapshot().bookings).toHaveLength(count);
  });
  it("blocks privilege escalation and another leader’s group management", async () => {
    const { mutateDemo, payload } = await setup();
    expect(() => mutateDemo("cancelRun", { ...payload(), cancellationReason: "Unsafe weather" })).toThrow("Administrator");
    expect(() => mutateDemo("updateRoute", { ...payload(), routeDescription: "Park loop" }, "leader")).toThrow("Assigned leader");
    expect(() => mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-runner", name: "Alex", roles: ["admin"], active: true })).toThrow("Administrator");
  });
  it("persists route edits only for the assigned leader", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const group = getDemoSnapshot().groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    mutateDemo("updateRoute", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, routeDescription: "Meet at the bridge." }, "leader");
    expect(getDemoSnapshot().groups.find(g => g.id === group.id)!.routeDescription).toBe("Meet at the bridge.");
    expect(getDemoSnapshot().groups.find(g => g.id === group.id)!.routeNeedsReview).toBe(false);
  });
  it("creates draft scaffolds, copies no bookings and blocks a second published future week", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const snapshot = mutateDemo("createWeek", { requestId: randomUUID(), date: "2026-10-13", copyFromRunId: run.id }, "admin");
    const created = snapshot.weeks.find(w => w.id === "demo-run-2026-10-13")!;
    const groups = snapshot.groups.filter(g => g.runId === created.id);
    expect(groups).toHaveLength(13);
    expect(groups.every(g => !g.leaderId && !g.sweeperId && g.routeNeedsReview)).toBe(true);
    expect(snapshot.bookings.some(b => b.runId === created.id)).toBe(false);
    expect(() => mutateDemo("publishRun", { requestId: randomUUID(), runId: created.id, runVersion: created.version }, "admin")).toThrow("Another future");
    expect(getDemoSnapshot("admin").audit[0].action).toBe("createWeek");
    expect(() => mutateDemo("createWeek", { requestId: randomUUID(), date: "2026-10-14" }, "admin")).toThrow("Tuesday");
  });
  it("retains cancelled booking history and cancellation reason", async () => {
    const { mutateDemo, run, payload, getDemoSnapshot } = await setup();
    const before = getDemoSnapshot("admin").bookings.filter(b => b.runId === run.id).length;
    mutateDemo("cancelRun", { ...payload(), cancellationReason: "Unsafe weather conditions." }, "admin");
    const after = getDemoSnapshot("admin");
    expect(after.weeks.find(w => w.id === run.id)!.cancellationReason).toBe("Unsafe weather conditions.");
    expect(after.bookings.filter(b => b.runId === run.id)).toHaveLength(before);
    expect(after.bookings.filter(b => b.runId === run.id).every(b => b.status === "cancelled")).toBe(true);
  });
  it("records actual attendance, keeps other unknown outcomes, and disallows pre-run outcomes", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const upcoming = getDemoSnapshot().groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    expect(() => mutateDemo("recordAttendance", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: upcoming.id, groupVersion: upcoming.version, memberId: "demo-leader", outcome: "present" }, "leader")).toThrow("after");
    const past = getDemoSnapshot().weeks.find(w => w.status === "archived")!;
    const group = getDemoSnapshot().groups.find(g => g.runId === past.id && g.leaderId === "demo-leader")!;
    const before = getDemoSnapshot().attendance.length;
    mutateDemo("recordAttendance", { requestId: randomUUID(), runId: past.id, runVersion: past.version, groupId: group.id, groupVersion: group.version, memberId: "demo-leader", outcome: "absent" }, "leader");
    const after = getDemoSnapshot();
    expect(after.attendance.length).toBeGreaterThanOrEqual(before);
    expect(after.attendance.find(a => a.runId === past.id && a.memberId === "demo-leader")!.outcome).toBe("absent");
    expect(after.bookings.find(b => b.runId === past.id && b.memberId === "demo-leader")!.status).toBe("confirmed");
  });
  it("replaces volunteer assignments without losing capacity or queue order", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const group = getDemoSnapshot("admin").groups.find(g => g.runId === run.id && g.number === 1)!;
    const beforeCount = confirmedCount(group.id, getDemoSnapshot("admin").bookings);
    const previous = group.sweeperId!;
    const replacement = getDemoSnapshot("admin").members.find(m => m.roles.includes("sweeper") && !getDemoSnapshot("admin").bookings.some(b => b.runId === run.id && b.memberId === m.id && b.status !== "cancelled"))!;
    mutateDemo("assignSweeper", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: replacement.id }, "leader");
    const snapshot = getDemoSnapshot("admin");
    expect(snapshot.groups.find(g => g.id === group.id)!.sweeperId).toBe(replacement.id);
    expect(snapshot.bookings.find(b => b.runId === run.id && b.memberId === previous)!.status).toBe("cancelled");
    expect(snapshot.bookings.find(b => b.runId === run.id && b.memberId === replacement.id)!.source).toBe("assignment");
    expect(confirmedCount(group.id, snapshot.bookings)).toBe(beforeCount);
  });
  it("keeps the whole state unchanged when a runner move fails", async () => {
    const { getDemoSnapshot, mutateDemo, run, payload } = await setup();
    const before = getDemoSnapshot("admin");
    const assigned = before.bookings.find(b => b.runId === run.id && b.source === "assignment" && b.status === "confirmed")!;
    expect(() => mutateDemo("moveRunner", { ...payload(), memberId: assigned.memberId }, "admin")).toThrow("assignment");
    expect(getDemoSnapshot("admin")).toEqual(before);
  });
  it("updates member roles and active status only with admin access", async () => {
    const { mutateDemo, getDemoSnapshot } = await setup();
    const snapshot = mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-runner", name: "Alex Updated", roles: ["runner", "sweeper"], active: true }, "admin");
    expect(snapshot.members.find(m => m.id === "demo-runner")!.name).toBe("Alex Updated");
    expect(getDemoSnapshot().members.find(m => m.id === "demo-runner")!.roles).toEqual(["runner", "sweeper"]);
    expect(() => mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-leader", name: "Priya", roles: ["runner"], active: false }, "admin")).toThrow("assignment");
  });
});
