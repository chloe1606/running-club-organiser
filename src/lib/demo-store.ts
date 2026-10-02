import { createDemoSnapshot, demoPersonas } from "./demo-data";
import { assertCanBook, assertCanPublish, bookingIsOpen, confirmedCount, nextBookingStatus, promoteFirstWaitlisted, type Group, type Run } from "./domain";
import type { PlatformSnapshot } from "./platform-types";
import { createRunSchedule } from "./schedule";
import { GatewayError } from "./gateway";

// Process-local only: restarts reset this explicitly enabled, synthetic demonstration.
let store: PlatformSnapshot | undefined;
const requests = new Map<string, string>();
function enabled() {
  if (process.env.CLUB_DEMO_MODE !== "true") throw new GatewayError("Demo mode is disabled.", 404, "DEMO_DISABLED");
  store ??= createDemoSnapshot();
  return store;
}
function memberFor(persona = "runner") {
  if (!Object.hasOwn(demoPersonas, persona)) throw new GatewayError("Unknown demo persona.", 400, "INVALID_PERSONA");
  return demoPersonas[persona as keyof typeof demoPersonas];
}
export function getDemoSnapshot(persona?: string): PlatformSnapshot {
  const snapshot = structuredClone(enabled());
  snapshot.currentMemberId = memberFor(persona);
  const admin = persona === "admin";
  if (!admin) {
    snapshot.members = snapshot.members.map(m => ({ ...m, email: "" }));
    snapshot.audit = [];
  }
  return snapshot;
}

export function mutateDemo(operation: string, payload: Record<string, unknown>, persona?: string): PlatformSnapshot {
  try {
    return applyMutation(operation, payload, persona);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(error instanceof Error ? error.message : "Invalid demonstration request.", 400, "DEMO_RULE");
  }
}

function applyMutation(operation: string, payload: Record<string, unknown>, persona?: string): PlatformSnapshot {
  const original = enabled();
  const actorId = memberFor(persona);
  const actor = original.members.find(m => m.id === actorId)!;
  if (!actor.active) throw new GatewayError("Active membership required.", 403, "FORBIDDEN");
  const requestId = String(payload.requestId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("A UUID request ID is required.");
  const requestKey = `${actorId}:${requestId}`;
  const fingerprint = JSON.stringify([operation, Object.keys(payload).sort().map(key => [key, payload[key]])]);
  if (requests.has(requestKey)) {
    if (requests.get(requestKey) !== fingerprint) throw new Error("This request ID was already used for a different action.");
    return getDemoSnapshot(persona);
  }
  const next = structuredClone(original);
  const run = next.weeks.find(r => r.id === payload.runId);
  const group = next.groups.find(g => g.id === payload.groupId);
  const now = new Date();
  const admin = actor.roles.includes("admin");
  const requireAdmin = () => { if (!admin) throw new GatewayError("Administrator access required.", 403, "FORBIDDEN"); };
  const requireRun = (): Run => {
    if (!run) throw new Error("Run not found.");
    if (payload.runVersion !== run.version) throw new GatewayError("This week changed. Refresh and try again.", 409, "STALE_VERSION");
    return run;
  };
  const requireGroup = (): Group => {
    requireRun();
    if (!group || group.runId !== run!.id) throw new Error("Group not found in this run.");
    if (payload.groupVersion !== group.version) throw new GatewayError("This group changed. Refresh and try again.", 409, "STALE_VERSION");
    return group;
  };
  const requireLeader = () => {
    requireGroup();
    if (!admin && (!actor.roles.includes("leader") || group!.leaderId !== actorId)) throw new GatewayError("Assigned leader access required.", 403, "FORBIDDEN");
  };
  const eligible = (id: string) => {
    const m = next.members.find(m => m.id === id && m.active);
    if (!m) throw new Error("Choose an active club member.");
    return m;
  };
  const leave = (memberId: string) => {
    const old = next.bookings.find(b => b.runId === run!.id && b.memberId === memberId && b.status !== "cancelled");
    if (!old) throw new Error("No active booking found.");
    if (old.source === "assignment") throw new Error("Remove the assignment before changing this booking.");
    const confirmed = old.status === "confirmed";
    old.status = "cancelled"; old.version++;
    const oldGroup = next.groups.find(g => g.id === old.groupId)!;
    if (confirmed) {
      const promoted = promoteFirstWaitlisted(old.groupId, next.bookings);
      if (promoted) { promoted.status = "confirmed"; promoted.version++; }
    }
    oldGroup.version++;
  };
  const book = (memberId: string, source: "member" | "assignment" = "member") => {
    const member = eligible(memberId);
    if (source === "member" && !member.roles.includes("runner")) throw new Error("Runner role required.");
    if (source === "member") assertCanBook(run!, group!, next.bookings, memberId, now);
    const status = nextBookingStatus(group!, next.bookings);
    if (source === "assignment" && status === "waitlisted") throw new Error("This group has no room for an assignment.");
    next.bookings.push({ id: `demo-booking-${requestId}-${memberId}`, runId: run!.id, groupId: group!.id,
      memberId, status, bookedAt: now.toISOString(), source, version: 1 });
    group!.version++;
  };
  switch (operation) {
    case "book": requireGroup(); book(actorId); break;
    case "leave": requireRun(); if (!bookingIsOpen(run!, now)) throw new Error("Booking is closed."); leave(actorId); break;
    case "switchGroup":
    case "moveRunner": {
      requireGroup();
      if (operation === "moveRunner") requireAdmin();
      if (!bookingIsOpen(run!, now)) throw new Error("Booking is closed.");
      const target = operation === "moveRunner" ? String(payload.memberId) : actorId;
      leave(target); book(target); break;
    }
    case "createWeek": {
      requireAdmin();
      const date = String(payload.date ?? "");
      const parsed = new Date(`${date}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || parsed.getUTCDay() !== 2) throw new Error("Choose a valid Tuesday.");
      if (next.weeks.some(w => w.id === `demo-run-${date}`)) throw new Error("This week already exists.");
      const created: Run = { id: `demo-run-${date}`, ...createRunSchedule(date, now, next.config), status: "draft", version: 1 };
      const template = next.weeks.find(w => w.id === payload.copyFromRunId) ?? next.weeks[0];
      next.weeks.push(created);
      for (const item of next.groups.filter(g => g.runId === template.id)) next.groups.push({ ...item, id: `${created.id}-group-${item.number}`, runId: created.id, leaderId: undefined, sweeperId: undefined, routeNeedsReview: true, version: 1 });
      break;
    }
    case "publishRun": requireAdmin(); requireRun(); if (run!.status !== "draft") throw new Error("Only draft weeks can be published."); assertCanPublish(run!, next.weeks, now); run!.status = "published"; run!.version++; break;
    case "cancelRun": {
      requireAdmin(); requireRun();
      if (!["published", "draft"].includes(run!.status)) throw new Error("This week cannot be cancelled.");
      const reason = String(payload.cancellationReason ?? "").trim();
      if (reason.length < 3) throw new Error("Please give a cancellation reason.");
      run!.status = "cancelled"; run!.cancellationReason = reason; run!.version++;
      next.bookings.filter(b => b.runId === run!.id && b.status !== "cancelled").forEach(b => { b.status = "cancelled"; b.version++; });
      next.groups.filter(g => g.runId === run!.id).forEach(g => { g.version++; });
      break;
    }
    case "archiveRun": requireAdmin(); requireRun(); if (new Date(run!.startsAt) > now && run!.status !== "cancelled") throw new Error("Only completed or cancelled weeks can be archived."); run!.status = "archived"; run!.version++; break;
    case "updateRoute":
      requireLeader();
      if (!["draft", "published"].includes(run!.status)) throw new Error("This week is not editable.");
      if (String(payload.routeDescription ?? "").trim().length < 3) throw new Error("Enter a route description.");
      group!.routeDescription = String(payload.routeDescription).trim(); group!.routeNeedsReview = false; group!.version++; break;
    case "assignLeader":
    case "assignSweeper": {
      if (operation === "assignLeader") { requireAdmin(); requireGroup(); } else requireLeader();
      if (!["draft", "published"].includes(run!.status)) throw new Error("This week is not editable.");
      const id = String(payload.memberId ?? "");
      if (operation === "assignLeader" && (!id || !eligible(id).roles.includes("leader"))) throw new Error("Choose an active leader.");
      if (id && !eligible(id).roles.includes(operation === "assignLeader" ? "leader" : "sweeper")) throw new Error("Choose a member with the appropriate volunteer role.");
      const field = operation === "assignLeader" ? "leaderId" : "sweeperId";
      const previous = group![field];
      if (id && (operation === "assignLeader" ? group!.sweeperId : group!.leaderId) === id) throw new Error("Leader and sweeper must be different members.");
      if (previous === id) break;
      const existing = id ? next.bookings.find(b => b.runId === run!.id && b.memberId === id && b.status !== "cancelled") : undefined;
      if (existing && existing.groupId !== group!.id) throw new Error("This member already occupies another group.");
      if (previous) {
        const old = next.bookings.find(b => b.runId === run!.id && b.memberId === previous && b.source === "assignment" && b.status !== "cancelled");
        if (old) { old.status = "cancelled"; old.version++; }
      }
      group![field] = id || undefined;
      if (existing) {
        if (existing.status !== "confirmed" && confirmedCount(group!.id, next.bookings) >= group!.capacity) throw new Error("This group has no room for an assignment.");
        existing.status = "confirmed"; existing.source = "assignment"; existing.version++;
      } else if (id) book(id, "assignment");
      if (confirmedCount(group!.id, next.bookings) < group!.capacity) {
        const promoted = promoteFirstWaitlisted(group!.id, next.bookings);
        if (promoted) { promoted.status = "confirmed"; promoted.version++; }
      }
      group!.version++;
      break;
    }
    case "recordAttendance": {
      requireLeader();
      if (new Date(run!.startsAt) > now || run!.status === "cancelled") throw new Error("Attendance is available after the run starts.");
      const id = String(payload.memberId);
      if (!next.bookings.some(b => b.groupId === group!.id && b.memberId === id && b.status === "confirmed")) throw new Error("This member is not confirmed in the group.");
      if (payload.outcome !== "present" && payload.outcome !== "absent") throw new Error("Choose present or absent.");
      next.attendance = next.attendance.filter(a => !(a.runId === run!.id && a.memberId === id));
      next.attendance.push({ id: `demo-attendance-${run!.id}-${id}`, runId: run!.id, groupId: group!.id, memberId: id, outcome: payload.outcome, recordedAt: now.toISOString() });
      group!.version++; break;
    }
    case "updateMember": {
      requireAdmin();
      const m = next.members.find(m => m.id === payload.memberId);
      if (!m) throw new Error("Member not found.");
      const roles = payload.roles;
      if (!Array.isArray(roles) || roles.length === 0 || roles.some(r => !["runner", "leader", "sweeper", "admin"].includes(r))) throw new Error("Choose valid member roles.");
      if (typeof payload.active !== "boolean" || !String(payload.name ?? "").trim()) throw new Error("A name and active status are required.");
      if (m.id === actorId && (!roles.includes("admin") || !payload.active)) throw new Error("You cannot remove your own administrator access.");
      if (next.groups.some(g => {
        const week = next.weeks.find(w => w.id === g.runId);
        if (!week || !["draft", "published"].includes(week.status) || new Date(week.startsAt) <= now) return false;
        return (g.leaderId === m.id && (!payload.active || !roles.includes("leader"))) ||
          (g.sweeperId === m.id && (!payload.active || !roles.includes("sweeper")));
      })) throw new Error("Replace this member’s future volunteer assignment before changing eligibility.");
      m.name = String(payload.name).trim(); m.roles = roles; m.active = payload.active; m.version++; break;
    }
    default: throw new Error("Unknown operation.");
  }
  for (const item of next.groups) if (confirmedCount(item.id, next.bookings) > item.capacity) throw new Error("Group capacity exceeded.");
  next.audit.unshift({ id: `demo-audit-${requestId}`, actorId, runId: run?.id ?? "", groupId: group?.id, memberId: String(payload.memberId ?? actorId), action: operation, at: now.toISOString(), requestId });
  store = next;
  requests.set(requestKey, fingerprint);
  return getDemoSnapshot(persona);
}
