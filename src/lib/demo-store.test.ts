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
  it("prepares drafts on an authorized enable, never on reads, and publishes/archives on a synthetic Sunday tick", async () => {
    const { getDemoSnapshot, mutateDemo, runDemoWeeklyAutomation } = await import("./demo-store");
    const initial = getDemoSnapshot("admin");
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const intent = { requestId: randomUUID(), configVersion: 1, enabled: true, publishTime: "18:00" };
    expect(() => mutateDemo("updateWeeklyAutomation", intent, "runner")).toThrow("Administrator");
    expect(getDemoSnapshot("admin").weeks).toEqual(initial.weeks);
    let snapshot = mutateDemo("updateWeeklyAutomation", intent, "admin");
    const draft = snapshot.weeks.find(week => week.status === "draft")!;
    expect(draft.id).toBe("demo-run-2026-10-13");
    const groups = snapshot.groups.filter(group => group.runId === draft.id);
    expect(groups.every(group => !group.cancelled && !group.leaderId && !group.sweeperId && !group.routeDescription)).toBe(true);
    expect(snapshot.bookings.filter(booking => booking.runId === draft.id)).toEqual([]);
    expect(mutateDemo("updateWeeklyAutomation", intent, "admin")).toEqual(snapshot);
    expect(() => mutateDemo("updateWeeklyAutomation", { ...intent, requestId: randomUUID() }, "admin")).toThrow("changed");
    const before = getDemoSnapshot("admin");
    vi.setSystemTime(new Date("2026-10-11T17:00:00Z"));
    expect(getDemoSnapshot("admin")).toEqual(before);
    runDemoWeeklyAutomation();
    snapshot = getDemoSnapshot("admin");
    expect(snapshot.weeks.find(week => week.id === initial.weeks[0].id)?.status).toBe("archived");
    expect(snapshot.attendance).toEqual(initial.attendance);
    expect(snapshot.bookings).toEqual(initial.bookings);
    expect(snapshot.weeks.find(week => week.id === draft.id)?.status).toBe("draft");
    const leader = snapshot.members.find(member => member.active && member.roles.includes("leader"))!;
    for (const group of groups) {
      snapshot = getDemoSnapshot("admin");
      const week = snapshot.weeks.find(week => week.id === draft.id)!;
      const payload = { requestId: randomUUID(), runId: week.id, runVersion: week.version, groupId: group.id, groupVersion: group.version };
      mutateDemo(group.number === 1 ? "assignLeader" : "cancelGroup", { ...payload, ...(group.number === 1 ? { memberId: leader.id } : { reason: "no-leader" }) }, "admin");
    }
    runDemoWeeklyAutomation();
    snapshot = getDemoSnapshot("admin");
    expect(snapshot.weeks.find(week => week.id === draft.id)?.status).toBe("published");
    expect(snapshotSchema.safeParse({ ...snapshot, demo: false }).success).toBe(true);
    runDemoWeeklyAutomation();
    expect(getDemoSnapshot("admin")).toEqual(snapshot);
  });

  it("changes future week times without extending published cutoffs or losing bookings", async () => {
    const { getDemoSnapshot, mutateDemo, run, payload } = await setup();
    const before = getDemoSnapshot("admin");
    expect(() => mutateDemo("updateWeekTime", { ...payload(), startTime: "20:00" }, "runner")).toThrow("Administrator");
    let snapshot = mutateDemo("updateWeekTime", { ...payload(), startTime: "20:00" }, "admin");
    expect(snapshot.weeks.find(week => week.id === run.id)).toMatchObject({ startsAt: "2026-10-06T19:00:00.000Z", bookingClosesAt: run.bookingClosesAt });
    expect(snapshot.bookings).toEqual(before.bookings);
    vi.setSystemTime(new Date("2026-10-06T17:45:00Z"));
    snapshot = mutateDemo("updateWeekTime", { ...payload(), startTime: "21:00" }, "admin");
    expect(snapshot.weeks.find(week => week.id === run.id)?.bookingClosesAt).toBe(run.bookingClosesAt);
    expect(() => mutateDemo("updateWeekTime", { ...payload(), startTime: "17:00" }, "admin")).toThrow("valid booking window");
    expect(getDemoSnapshot("admin")).toEqual(snapshot);
  });

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
    expect(new Set(snapshot.members.map(member => member.name)).size).toBe(snapshot.members.length);
    expect(snapshot.members.every(member => !/\s\d+$/.test(member.name))).toBe(true);
    expect(new Set(snapshot.groups.slice(0, 13).map(g => confirmedCount(g.id, snapshot.bookings))).size).toBeGreaterThan(5);
    expect(snapshot.groups.every(g => confirmedCount(g.id, snapshot.bookings) <= g.capacity)).toBe(true);
    const upcomingGroups = snapshot.groups.filter(group => group.runId === snapshot.weeks[0].id);
    expect(upcomingGroups.find(group => group.cancellationReason === "low-interest")?.cancelled).toBe(true);
    expect(upcomingGroups.find(group => group.cancellationReason === "no-leader")).toMatchObject({ cancelled: true, leaderId: undefined });
  });
  it("uses club-local Tuesday, including DST change, rather than a hard-coded week", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-23T12:00:00Z"));
    expect(snapshot.weeks[0].startsAt).toBe("2026-10-27T19:00:00.000Z");
    expect(snapshot.weeks[0].bookingClosesAt).toBe("2026-10-27T18:30:00.000Z");
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
    expect(() => mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-runner", memberVersion: 1, name: "Alex", roles: ["admin"], active: true })).toThrow("Administrator");
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
    expect(groups.every(g => !g.leaderId && !g.sweeperId && !g.routeNeedsReview)).toBe(true);
    expect(snapshot.bookings.some(b => b.runId === created.id)).toBe(false);
    expect(() => mutateDemo("publishRun", { requestId: randomUUID(), runId: created.id, runVersion: created.version }, "admin")).toThrow("Another future");
    expect(getDemoSnapshot("admin").audit[0].action).toBe("createWeek");
    expect(() => mutateDemo("createWeek", { requestId: randomUUID(), date: "2026-10-14" }, "admin")).toThrow("Tuesday");
  });
  it("uses saved map links for new weeks and allows admins to change a future week's venue", async () => {
    const { getDemoSnapshot, mutateDemo } = await setup();
    const before = getDemoSnapshot("admin");
    const mapsUrl = "https://www.google.com/maps/place/Oakfield+Pavilion/";
    const locations = before.config.locations ?? [];
    mutateDemo("updateLocations", {
      requestId: randomUUID(), location: "Oakfield Pavilion", locations: [...locations, "Oakfield Pavilion"],
      locationMaps: { "Oakfield Pavilion": mapsUrl },
    }, "admin");
    let snapshot = mutateDemo("createWeek", {
      requestId: randomUUID(), date: "2026-10-13", location: "Oakfield Pavilion",
    }, "admin");
    let created = snapshot.weeks.find(week => week.id === "demo-run-2026-10-13")!;
    const createdId = created.id;
    expect(created).toMatchObject({ location: "Oakfield Pavilion", mapsUrl });
    snapshot = mutateDemo("updateWeekLocation", {
      requestId: randomUUID(), runId: createdId, runVersion: created.version, location: "Riverside Pavilion, Meadow Lane",
    }, "admin");
    created = snapshot.weeks.find(week => week.id === createdId)!;
    expect(created.location).toBe("Riverside Pavilion, Meadow Lane");
    expect(created.mapsUrl).toBeUndefined();
  });
  it("retains cancelled booking history and cancellation reason", async () => {
    const { mutateDemo, run, payload, getDemoSnapshot } = await setup();
    const before = getDemoSnapshot("admin").bookings.filter(b => b.runId === run.id).length;
    mutateDemo("cancelRun", { ...payload(), cancellationReason: "Unsafe weather conditions." }, "admin");
    const after = getDemoSnapshot("admin");
    expect(after.weeks.find(w => w.id === run.id)!.cancellationReason).toBe("Unsafe weather conditions.");
    expect(after.bookings.filter(b => b.runId === run.id)).toHaveLength(before);
    expect(after.bookings.filter(b => b.runId === run.id).every(b => b.status === "cancelled")).toBe(true);
    expect(() => mutateDemo("archiveRun", { requestId: randomUUID(), runId: run.id, runVersion: after.weeks.find(w => w.id === run.id)!.version }, "admin")).toThrow("cancelled weeks remain cancelled");
  });
  it("records actual attendance, keeps other unknown outcomes, and disallows pre-run outcomes", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const upcoming = getDemoSnapshot().groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    expect(() => mutateDemo("recordAttendance", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: upcoming.id, groupVersion: upcoming.version, memberId: "demo-leader", outcome: "present" }, "leader")).toThrow("after");
    const past = getDemoSnapshot().weeks.find(w => w.status === "archived")!;
    const pastGroup = getDemoSnapshot().groups.find(g => g.runId === past.id && g.leaderId === "demo-leader")!;
    expect(() => mutateDemo("recordAttendance", { requestId: randomUUID(), runId: past.id, runVersion: past.version, groupId: pastGroup.id, groupVersion: pastGroup.version, memberId: "demo-leader", outcome: "present" }, "leader")).toThrow("before archival");
    vi.setSystemTime(new Date(new Date(run.startsAt).getTime() + 60000));
    const before = getDemoSnapshot().attendance.length;
    mutateDemo("recordAttendance", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: upcoming.id, groupVersion: upcoming.version, memberId: "demo-leader", outcome: "absent" }, "leader");
    const after = getDemoSnapshot();
    expect(after.attendance.length).toBeGreaterThanOrEqual(before);
    expect(after.attendance.find(a => a.runId === run.id && a.memberId === "demo-leader")!.outcome).toBe("absent");
    expect(after.bookings.find(b => b.runId === run.id && b.memberId === "demo-leader")!.status).toBe("confirmed");
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
  it("clears a leader assignment when None is selected", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const group = getDemoSnapshot("admin").groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    mutateDemo("assignLeader", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: "" }, "admin");
    const snapshot = getDemoSnapshot("admin");
    expect(snapshot.groups.find(g => g.id === group.id)!.leaderId).toBeUndefined();
    expect(snapshot.bookings.find(b => b.runId === run.id && b.groupId === group.id && b.memberId === "demo-leader")!.status).toBe("cancelled");
  });
  it("keeps the leader place empty instead of promoting a waitlisted runner when the leader is removed", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const before = getDemoSnapshot("admin");
    const group = before.groups.find(g => g.runId === run.id && g.number === 3)!;
    expect(before.bookings.some(b => b.groupId === group.id && b.status === "waitlisted")).toBe(true);
    mutateDemo("assignLeader", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: "" }, "admin");
    const after = getDemoSnapshot("admin");
    expect(confirmedCount(group.id, after.bookings, after.groups.find(g => g.id === group.id))).toBe(group.capacity - 1);
    expect(after.bookings.some(b => b.groupId === group.id && b.status === "waitlisted")).toBe(true);
  });
  it("assigns an available leader after a group is set to None", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const initial = getDemoSnapshot("admin");
    const group = initial.groups.find(g => g.runId === run.id && g.number === 1)!;
    const availableLeader = initial.members.find(member => member.active && member.roles.includes("leader") &&
      !initial.groups.some(other => other.runId === run.id && [other.leaderId, other.sweeperId].includes(member.id)) &&
      !initial.bookings.some(booking => booking.runId === run.id && booking.memberId === member.id && booking.status !== "cancelled"))!;
    mutateDemo("assignLeader", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: "" }, "admin");
    const cleared = getDemoSnapshot("admin");
    const currentRun = cleared.weeks.find(week => week.id === run.id)!;
    const currentGroup = cleared.groups.find(item => item.id === group.id)!;
    const assigned = mutateDemo("assignLeader", { requestId: randomUUID(), runId: run.id, runVersion: currentRun.version, groupId: currentGroup.id, groupVersion: currentGroup.version, memberId: availableLeader.id }, "admin");
    expect(assigned.groups.find(item => item.id === group.id)!.leaderId).toBe(availableLeader.id);
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
    const snapshot = mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-runner", memberVersion: 1, name: "Alex Updated", roles: ["runner", "sweeper"], active: true }, "admin");
    expect(snapshot.members.find(m => m.id === "demo-runner")!.name).toBe("Alex Updated");
    expect(getDemoSnapshot().members.find(m => m.id === "demo-runner")!.roles).toEqual(["runner", "sweeper"]);
    expect(() => mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-leader", memberVersion: 1, name: "Priya", roles: ["runner"], active: false }, "admin")).toThrow("assignment");
    expect(() => mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-runner", memberVersion: 1, name: "Stale Alex", roles: ["runner"], active: true }, "admin")).toThrow("changed");
  });
  it("lets a runner with the sweeper role opt in while booking a confirmed place", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    mutateDemo("updateMember", {
      requestId: randomUUID(), memberId: "demo-runner", memberVersion: 1,
      name: "Alex Morgan", roles: ["runner", "sweeper"], active: true,
    }, "admin");
    const before = getDemoSnapshot("admin");
    const group = before.groups.find(g => g.runId === run.id && !g.sweeperId && confirmedCount(g.id, before.bookings) < g.capacity)!;
    const after = mutateDemo("book", {
      requestId: randomUUID(), runId: run.id, runVersion: run.version,
      groupId: group.id, groupVersion: group.version, sweeper: true,
    }, "runner");
    expect(after.groups.find(g => g.id === group.id)?.sweeperId).toBe("demo-runner");
    expect(after.bookings.find(b => b.runId === run.id && b.memberId === "demo-runner")).toMatchObject({
      groupId: group.id, status: "confirmed", source: "member",
    });
  });
  it("lets an assigned leader cancel their group for low interest and blocks new bookings", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const before = getDemoSnapshot("admin");
    const group = before.groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    const activeIds = before.bookings.filter(b => b.groupId === group.id && b.status !== "cancelled").map(b => b.id);
    const cancelled = mutateDemo("cancelGroup", {
      requestId: randomUUID(), runId: run.id, runVersion: run.version,
      groupId: group.id, groupVersion: group.version, reason: "low-interest",
    }, "leader");
    const cancelledGroup = cancelled.groups.find(g => g.id === group.id)!;
    expect(cancelledGroup).toMatchObject({ cancelled: true, cancellationReason: "low-interest" });
    expect(cancelled.bookings.filter(b => activeIds.includes(b.id)).every(b => b.status === "cancelled")).toBe(true);
    expect(() => mutateDemo("book", {
      requestId: randomUUID(), runId: run.id, runVersion: cancelled.weeks.find(w => w.id === run.id)!.version,
      groupId: group.id, groupVersion: cancelledGroup.version,
    }, "runner")).toThrow("not running");
  });
  it("cancels future ordinary bookings and promotes the queue when runner eligibility is removed", async () => {
    const { getDemoSnapshot, mutateDemo, run, group } = await setup();
    const snapshot = getDemoSnapshot("admin");
    const runner = snapshot.bookings.find(b => b.groupId === group.id && b.source === "member" && b.status === "confirmed")!;
    const queued = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted").sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))[0];
    const member = snapshot.members.find(m => m.id === runner.memberId)!;
    mutateDemo("updateMember", { requestId: randomUUID(), memberId: member.id, memberVersion: member.version, name: member.name, roles: ["runner"], active: false }, "admin");
    const after = getDemoSnapshot("admin");
    expect(after.bookings.find(b => b.id === runner.id)!.status).toBe("cancelled");
    expect(after.bookings.find(b => b.id === queued.id)!.status).toBe("confirmed");
    expect(after.audit.some(a => a.action === "promoted" && a.memberId === queued.memberId && a.runId === run.id)).toBe(true);
  });
  it("never promotes waitlisted runners at or after the booking cutoff", async () => {
    const { getDemoSnapshot, mutateDemo, run, group } = await setup();
    const snapshot = getDemoSnapshot("admin");
    const runner = snapshot.bookings.find(b => b.groupId === group.id && b.source === "member" && b.status === "confirmed")!;
    const queued = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted").sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))[0];
    const member = snapshot.members.find(m => m.id === runner.memberId)!;
    vi.setSystemTime(new Date(run.bookingClosesAt));
    mutateDemo("updateMember", { requestId: randomUUID(), memberId: member.id, memberVersion: member.version, name: member.name, roles: ["runner"], active: false }, "admin");
    expect(getDemoSnapshot("admin").bookings.find(b => b.id === queued.id)!.status).toBe("waitlisted");
    expect(getDemoSnapshot("admin").bookings.find(b => b.id === runner.id)!.status).toBe("cancelled");
  });
  it("allows a dual-role volunteer, counts them once and retains their booking when one role is removed", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    mutateDemo("updateMember", { requestId: randomUUID(), memberId: "demo-leader", memberVersion: 1, name: "Priya Shah", roles: ["runner", "leader", "sweeper"], active: true }, "admin");
    let snapshot = getDemoSnapshot("admin");
    let group = snapshot.groups.find(g => g.runId === run.id && g.leaderId === "demo-leader")!;
    const beforeCount = confirmedCount(group.id, snapshot.bookings);
    mutateDemo("assignSweeper", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: "demo-leader" }, "leader");
    snapshot = getDemoSnapshot("admin");
    group = snapshot.groups.find(g => g.id === group.id)!;
    expect(group.sweeperId).toBe(group.leaderId);
    expect(snapshot.bookings.filter(b => b.runId === run.id && b.memberId === "demo-leader" && b.status !== "cancelled")).toHaveLength(1);
    expect(confirmedCount(group.id, snapshot.bookings)).toBe(beforeCount - 1);
    mutateDemo("assignSweeper", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: "" }, "leader");
    snapshot = getDemoSnapshot("admin");
    expect(snapshot.groups.find(g => g.id === group.id)!.sweeperId).toBeUndefined();
    expect(snapshot.bookings.find(b => b.runId === run.id && b.memberId === "demo-leader" && b.status !== "cancelled")!.status).toBe("confirmed");
  });
  it("fills the final available place with a volunteer without counting their new assignment twice", async () => {
    const { getDemoSnapshot, mutateDemo, run } = await setup();
    const snapshot = getDemoSnapshot("admin");
    const group = snapshot.groups.find(g => g.runId === run.id && g.number === 9)!;
    expect(confirmedCount(group.id, snapshot.bookings)).toBe(18);
    const member = snapshot.members.find(m => m.roles.includes("sweeper") && !snapshot.bookings.some(b => b.runId === run.id && b.memberId === m.id && b.status !== "cancelled"))!;
    mutateDemo("assignSweeper", { requestId: randomUUID(), runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, memberId: member.id }, "admin");
    const after = getDemoSnapshot("admin");
    expect(confirmedCount(group.id, after.bookings)).toBe(19);
    expect(after.bookings.find(b => b.runId === run.id && b.memberId === member.id)!.status).toBe("confirmed");
  });
});
