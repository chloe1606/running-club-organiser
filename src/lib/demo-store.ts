import { createDemoSnapshot, demoPersonas } from "./demo-data";
import { assertCanBook, assertCanPublish, bookingCapacity, bookingIsOpen, confirmedCount, nextBookingStatus, promoteFirstWaitlisted, type Group, type Run } from "./domain";
import type { PlatformSnapshot } from "./platform-types";
import { clubDate, createRunSchedule, nextTuesdayDate, publicationBlockers, sundayPublicationAt, updateRunTime } from "./schedule";
import { GatewayError } from "./gateway";
import { DEFAULT_LOCATION_MAPS } from "./locations";

// Process-local only: restarts reset this explicitly enabled, synthetic demonstration.
let store: PlatformSnapshot | undefined;
const requests = new Map<string, string>();
function validDemoMapsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com") || url.hostname === "maps.app.goo.gl");
  } catch { return false; }
}
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

function weeklyAutomation(next: PlatformSnapshot, now: Date, actorId: string) {
  if (!next.config.weeklyAutomationEnabled) return;
  const audit = (action: string, run: Run) => {
    const requestId = crypto.randomUUID();
    next.audit.unshift({ id: `demo-audit-${requestId}`, actorId, runId: run.id, action, at: now.toISOString(), requestId });
  };
  const date = nextTuesdayDate(now, next.config.timeZone);
  let run = next.weeks.find(week => clubDate(new Date(week.startsAt), next.config.timeZone) === date);
  if (!run) {
    const location = next.config.location;
    run = { id: `demo-run-${date}`, ...createRunSchedule(date, now, next.config), location,
      ...(next.config.locationMaps?.[location] ? { mapsUrl: next.config.locationMaps[location] } : {}), status: "draft", version: 1 };
    next.weeks.push(run);
    for (const definition of createDemoSnapshot(now).groups.slice(0, 13)) {
      next.groups.push({ id: `${run.id}-group-${definition.number}`, runId: run.id, number: definition.number, name: definition.name,
        paceLabel: definition.paceLabel, distanceLabel: definition.distanceLabel, capacity: definition.capacity,
        routeDescription: "", routeNeedsReview: false, version: 1 });
    }
    audit("createWeek", run);
  }
  const publication = sundayPublicationAt(run, next.config);
  const localDate = clubDate(now, next.config.timeZone);
  const archiveSunday = new Date(`${localDate}T12:00:00Z`);
  const sundayOffset = archiveSunday.getUTCDay();
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: next.config.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  archiveSunday.setUTCDate(archiveSunday.getUTCDate() - sundayOffset - (sundayOffset === 0 && localTime < (next.config.weeklyPublishTime ?? "18:00") ? 7 : 0));
  const sunday = archiveSunday.toISOString().slice(0, 10);
  for (const week of next.weeks.filter(week => week.status === "published" && clubDate(new Date(week.startsAt), next.config.timeZone) < sunday)) {
    week.status = "archived"; week.version++; audit("archiveRun", week);
  }
  if (now < new Date(publication)) return;
  if (run.status === "draft" && !publicationBlockers(next, run, now).length && Date.parse(run.bookingClosesAt) > now.getTime()) {
    assertCanPublish(run, next.weeks, now);
    run.status = "published"; run.version++; audit("publishRun", run);
  }
}

export function runDemoWeeklyAutomation(now = new Date()): void {
  const next = structuredClone(enabled());
  weeklyAutomation(next, now, "weekly-automation");
  store = next;
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
  const queueEvent = (action: "waitlistJoined" | "promoted" | "withdrawn", groupId: string, memberId: string) => {
    next.audit.unshift({ id: `demo-audit-${requestId}-${action}-${memberId}`, actorId, runId: next.groups.find(g => g.id === groupId)?.runId ?? "", groupId, memberId,
      action, at: now.toISOString(), requestId, queueSize: next.bookings.filter(b => b.groupId === groupId && b.status === "waitlisted").length });
  };
  const promote = (groupId: string) => {
    const target = next.groups.find(g => g.id === groupId)!;
    const week = next.weeks.find(w => w.id === target.runId);
    if (!week || target.cancelled || !bookingIsOpen(week, now)) return;
    while (confirmedCount(groupId, next.bookings, target) < bookingCapacity(target)) {
      const queued = promoteFirstWaitlisted(groupId, next.bookings);
      if (!queued) break;
      const member = next.members.find(m => m.id === queued.memberId);
      queued.version++;
      if (!member?.active || !member.roles.includes("runner")) { queued.status = "cancelled"; queueEvent("withdrawn", groupId, queued.memberId); }
      else { queued.status = "confirmed"; queueEvent("promoted", groupId, queued.memberId); }
    }
  };
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
    if (group.cancelled && operation !== "cancelGroup") throw new Error("This group is not running.");
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
    if (old.source === "member" && oldGroup.sweeperId === memberId) delete oldGroup.sweeperId;
    if (confirmed) promote(old.groupId);
    else queueEvent("withdrawn", old.groupId, old.memberId);
    oldGroup.version++;
  };
  const book = (memberId: string, source: "member" | "assignment" = "member", volunteerAsSweeper = false) => {
    const member = eligible(memberId);
    if (source === "member" && !member.roles.includes("runner")) throw new Error("Runner role required.");
    if (volunteerAsSweeper && !member.roles.includes("sweeper")) throw new Error("Sweeper role required.");
    if (source === "member") assertCanBook(run!, group!, next.bookings, memberId, now);
    const status = source === "assignment"
      ? (confirmedCount(group!.id, next.bookings, group) <= bookingCapacity(group!) ? "confirmed" : "waitlisted")
      : nextBookingStatus(group!, next.bookings);
    if (source === "assignment" && status === "waitlisted") throw new Error("This group has no room for an assignment.");
    if (volunteerAsSweeper && status !== "confirmed") throw new Error("A sweeper volunteer needs a confirmed place in the group.");
    if (volunteerAsSweeper && group!.sweeperId && group!.sweeperId !== memberId) throw new Error("This group already has a sweeper.");
    if (volunteerAsSweeper) group!.sweeperId = memberId;
    next.bookings.push({ id: `demo-booking-${requestId}-${memberId}`, runId: run!.id, groupId: group!.id,
      memberId, status, bookedAt: now.toISOString(), source, version: 1 });
    if (status === "waitlisted") queueEvent("waitlistJoined", group!.id, memberId);
    group!.version++;
  };
  switch (operation) {
    case "updateWeeklyAutomation": {
      requireAdmin();
      if (payload.configVersion !== (next.config.version ?? 1)) throw new GatewayError("Club settings changed. Refresh and try again.", 409, "STALE_VERSION");
      if (typeof payload.enabled !== "boolean" || typeof payload.publishTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.publishTime)) throw new Error("Supply an enabled flag and Sunday publication time as HH:mm.");
      next.config.weeklyAutomationEnabled = payload.enabled;
      next.config.weeklyPublishTime = payload.publishTime;
      next.config.version = (next.config.version ?? 1) + 1;
      weeklyAutomation(next, now, actorId);
      break;
    }
    case "updateWeekTime": {
      requireAdmin(); requireRun();
      Object.assign(run!, updateRunTime(run!, String(payload.startTime ?? ""), next.config, now));
      run!.version++;
      break;
    }
    case "cancelGroup": {
      requireGroup();
      if (!admin && (!actor.roles.includes("leader") || group!.leaderId !== actorId)) throw new GatewayError("Assigned leader access required.", 403, "FORBIDDEN");
      if (!admin && payload.reason !== "low-interest") throw new GatewayError("Only an administrator can mark a group not running because no leader is available.", 403, "FORBIDDEN");
      if (payload.reason === "no-leader" && group!.leaderId) throw new Error("Remove the assigned leader before marking this group not running.");
      if (!["low-interest", "no-leader"].includes(String(payload.reason))) throw new Error("Choose a supported reason for not running this group.");
      if (!run || !["draft", "published"].includes(run.status) || new Date(run.startsAt) <= now) throw new Error("Only a future draft or published group can be marked not running.");
      if (group!.cancelled) throw new Error("This group is already marked not running.");
      group!.cancelled = true;
      group!.cancellationReason = payload.reason as "low-interest" | "no-leader";
      next.bookings.filter(booking => booking.runId === run.id && booking.groupId === group!.id && booking.status !== "cancelled")
        .forEach(booking => { booking.status = "cancelled"; booking.version++; });
      group!.version++;
      run.version++;
      break;
    }
    case "updateLocations": {
      requireAdmin();
      const locations = payload.locations;
      const location = String(payload.location ?? "").trim();
      if (!Array.isArray(locations) || !locations.length || locations.length > 30 ||
          locations.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 120) ||
          new Set(locations.map(value => value.trim().toLowerCase())).size !== locations.length ||
          !locations.includes(location)) throw new Error("Choose a saved location or add a unique location name.");
      const removedLocations = (next.config.locations ?? []).filter(existing => !locations.some(value => value.toLowerCase() === existing.toLowerCase()));
      if (next.weeks.some(week => removedLocations.includes(week.location ?? "") && ["draft", "published"].includes(week.status) && new Date(week.startsAt) > now)) {
        throw new Error("A future week uses this location. Change that week's location before removing it.");
      }
      next.config.locations = locations.map(value => value.trim());
      next.config.location = location;
      const locationMaps = Object.assign({}, DEFAULT_LOCATION_MAPS, (payload.locationMaps as Record<string, string> | undefined) ?? next.config.locationMaps ?? {});
      Object.keys(locationMaps).forEach(venue => { if (!next.config.locations!.includes(venue)) delete locationMaps[venue]; });
      if (Object.entries(locationMaps).some(([venue, url]) => !next.config.locations!.includes(venue) || !validDemoMapsUrl(url))) {
        throw new Error("Use valid Google Maps HTTPS links for saved venues.");
      }
      next.config.locationMaps = locationMaps;
      next.config.version = (next.config.version ?? 1) + 1;
      break;
    }
    case "updateWeekLocation": {
      requireAdmin();
      requireRun();
      if (!["draft", "published"].includes(run!.status) || new Date(run!.startsAt) <= now) throw new Error("Only a future draft or published week can change location.");
      const location = String(payload.location ?? "").trim();
      if (!next.config.locations?.includes(location)) throw new Error("Choose a saved venue for this week.");
      run!.location = location;
      const mapsUrl = next.config.locationMaps?.[location];
      if (mapsUrl) run!.mapsUrl = mapsUrl;
      else delete run!.mapsUrl;
      run!.version++;
      break;
    }
    case "book": requireGroup(); book(actorId, "member", payload.sweeper === true); break;
    case "leave": requireRun(); if (!bookingIsOpen(run!, now)) throw new Error("Booking is closed."); leave(actorId); break;
    case "switchGroup":
    case "moveRunner": {
      requireGroup();
      if (operation === "moveRunner") requireAdmin();
      if (!bookingIsOpen(run!, now)) throw new Error("Booking is closed.");
      const target = operation === "moveRunner" ? String(payload.memberId) : actorId;
      leave(target); book(target, "member", operation === "switchGroup" && payload.sweeper === true); break;
    }
    case "createWeek": {
      requireAdmin();
      const date = String(payload.date ?? "");
      const parsed = new Date(`${date}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || parsed.getUTCDay() !== 2) throw new Error("Choose a valid Tuesday.");
      if (next.weeks.some(w => w.id === `demo-run-${date}`)) throw new Error("This week already exists.");
      const locations = next.config.locations ?? [next.config.location].filter(location => !/\bDEMO\b/i.test(location));
      const configuredLocation = next.config.location;
      const location = String(payload.location || (locations.includes(configuredLocation) ? configuredLocation : locations[0]) || configuredLocation || "").trim();
      if (!locations.includes(location) && !(next.config.demoConfiguration && !locations.length)) throw new Error("Choose a saved venue for this week.");
      const created: Run = { id: `demo-run-${date}`, ...createRunSchedule(date, now, next.config), location,
        ...(next.config.locationMaps?.[location] ? { mapsUrl: next.config.locationMaps[location] } : {}), status: "draft", version: 1 };
      const template = payload.copyFromRunId ? next.weeks.find(w => w.id === payload.copyFromRunId) : undefined;
      if (payload.copyFromRunId && !template) throw new Error("Source week not found.");
      next.weeks.push(created);
      for (const definition of createDemoSnapshot(now).groups.slice(0, 13)) {
        const copied = template ? next.groups.find(g => g.runId === template.id && g.number === definition.number) : undefined;
        next.groups.push({ ...definition, id: `${created.id}-group-${definition.number}`, runId: created.id,
          leaderId: undefined, sweeperId: undefined, routeDescription: copied?.routeDescription ?? "", routeNeedsReview: false, version: 1 });
      }
      break;
    }
    case "publishRun": requireAdmin(); requireRun(); if (run!.status !== "draft") throw new Error("Only draft weeks can be published."); assertCanPublish(run!, next.weeks, now); run!.status = "published"; run!.version++; break;
    case "cancelRun": {
      requireAdmin(); requireRun();
      if (!["published", "draft"].includes(run!.status)) throw new Error("This week cannot be cancelled.");
      if (new Date(run!.startsAt) <= now) throw new Error("Only future weeks can be cancelled.");
      const reason = String(payload.cancellationReason ?? "").trim();
      if (reason.length < 3) throw new Error("Please give a cancellation reason.");
      run!.status = "cancelled"; run!.cancellationReason = reason; run!.version++;
      next.bookings.filter(b => b.runId === run!.id && b.status !== "cancelled").forEach(b => { b.status = "cancelled"; b.version++; });
      next.groups.filter(g => g.runId === run!.id).forEach(g => { g.version++; });
      break;
    }
    case "archiveRun": requireAdmin(); requireRun(); if (run!.status === "cancelled" || run!.status === "draft" || run!.status === "archived" || new Date(run!.startsAt) > now) throw new Error("Only completed published weeks can be archived; cancelled weeks remain cancelled."); run!.status = "archived"; run!.version++; break;
    case "updateRoute":
      requireLeader();
      if (!["draft", "published"].includes(run!.status)) throw new Error("This week is not editable.");
      if (new Date(run!.startsAt) <= now) throw new Error("Only future routes can be edited.");
      if (String(payload.routeDescription ?? "").trim().length < 3) throw new Error("Enter a route description.");
      group!.routeDescription = String(payload.routeDescription).trim(); group!.routeNeedsReview = false; group!.version++; break;
    case "assignLeader":
    case "assignSweeper": {
      if (operation === "assignLeader") { requireAdmin(); requireGroup(); } else requireLeader();
      if (!["draft", "published"].includes(run!.status)) throw new Error("This week is not editable.");
      if (new Date(run!.startsAt) <= now) throw new Error("Only future assignments can be edited.");
      const id = String(payload.memberId ?? "");
      if (operation === "assignLeader" && id && !eligible(id).roles.includes("leader")) throw new Error("Choose an active leader.");
      if (id && !eligible(id).roles.includes(operation === "assignLeader" ? "leader" : "sweeper")) throw new Error("Choose a member with the appropriate volunteer role.");
      const field = operation === "assignLeader" ? "leaderId" : "sweeperId";
      const otherField = operation === "assignLeader" ? "sweeperId" : "leaderId";
      const previous = group![field];
      if (previous === id) break;
      const existing = id ? next.bookings.find(b => b.runId === run!.id && b.memberId === id && b.status !== "cancelled") : undefined;
      if (existing && existing.groupId !== group!.id) throw new Error("This member already occupies another group.");
      if (previous && group![otherField] !== previous) {
        const old = next.bookings.find(b => b.runId === run!.id && b.memberId === previous && b.source === "assignment" && b.status !== "cancelled");
        if (old) { old.status = "cancelled"; old.version++; }
      }
      group![field] = id || undefined;
      if (existing) {
        if (existing.status !== "confirmed" && confirmedCount(group!.id, next.bookings, group) > bookingCapacity(group!)) throw new Error("This group has no room for an assignment.");
        existing.status = "confirmed"; existing.source = "assignment"; existing.version++;
      } else if (id) book(id, "assignment");
      promote(group!.id);
      group!.version++;
      break;
    }
    case "recordAttendance": {
      requireLeader();
      if (new Date(run!.startsAt) > now || ["cancelled", "archived", "draft"].includes(run!.status)) throw new Error("Attendance is available after a published run starts, before archival.");
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
      if (payload.memberVersion !== m.version) throw new GatewayError("This member changed. Refresh and try again.", 409, "STALE_VERSION");
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
      m.name = String(payload.name).trim(); m.roles = roles; m.active = payload.active; m.version++;
      if (!m.active || !m.roles.includes("runner")) {
        const affected = new Set<string>();
        for (const booking of next.bookings.filter(b => b.memberId === m.id && b.source === "member" && b.status !== "cancelled")) {
          const week = next.weeks.find(w => w.id === booking.runId);
          if (!week || new Date(week.startsAt) <= now || !["draft", "published"].includes(week.status)) continue;
          const waiting = booking.status === "waitlisted";
          booking.status = "cancelled"; booking.version++; affected.add(booking.groupId);
          if (waiting) queueEvent("withdrawn", booking.groupId, booking.memberId);
        }
        for (const id of affected) { promote(id); next.groups.find(g => g.id === id)!.version++; }
      }
      break;
    }
    default: throw new Error("Unknown operation.");
  }
  for (const item of next.groups) if (confirmedCount(item.id, next.bookings, item) > bookingCapacity(item)) throw new Error("Group capacity exceeded.");
  next.audit.unshift({ id: `demo-audit-${requestId}`, actorId, runId: run?.id ?? "", groupId: group?.id, memberId: String(payload.memberId ?? actorId), action: operation, at: now.toISOString(), requestId });
  store = next;
  requests.set(requestKey, fingerprint);
  return getDemoSnapshot(persona);
}
