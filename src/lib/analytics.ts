import type { PlatformSnapshot } from "./platform-types";

export function queuePosition(snapshot: PlatformSnapshot, groupId: string, memberId: string) {
  const queue = snapshot.bookings.filter(b => b.groupId === groupId && b.status === "waitlisted")
    .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id));
  const position = queue.findIndex(b => b.memberId === memberId);
  return position < 0 ? undefined : position + 1;
}

export function favouriteGroup(snapshot: PlatformSnapshot, memberId: string) {
  const counts = new Map<number, number>();
  for (const item of snapshot.attendance.filter(a => a.memberId === memberId && a.outcome === "present")) {
    const group = snapshot.groups.find(g => g.id === item.groupId);
    const run = snapshot.weeks.find(w => w.id === item.runId);
    if (group && run && run.status !== "cancelled") counts.set(group.number, (counts.get(group.number) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

export function weeklyAnalytics(snapshot: PlatformSnapshot, now = new Date()) {
  return [...snapshot.weeks].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(run => {
    const confirmed = snapshot.bookings.filter(b => b.runId === run.id && b.status === "confirmed");
    const actual = snapshot.attendance.filter(a => a.runId === run.id);
    const present = actual.filter(a => a.outcome === "present").length;
    const absent = actual.filter(a => a.outcome === "absent").length;
    const recorded = new Set(actual.map(a => a.memberId));
    const unknown = confirmed.filter(b => !recorded.has(b.memberId)).length;
    const capacity = run.status === "cancelled" ? 0 : snapshot.groups.filter(g => g.runId === run.id).reduce((n, g) => n + g.capacity, 0);
    return { run, capacity, confirmed: confirmed.length, present, absent, unknown,
      attendanceUtilisation: capacity && actual.length && new Date(run.startsAt) <= now ? Math.round(present / capacity * 100) : undefined,
      waitlisted: snapshot.bookings.filter(b => b.runId === run.id && b.status === "waitlisted").length,
      attendanceRate: present + absent ? Math.round(present / (present + absent) * 100) : undefined };
  });
}

export function groupAnalytics(snapshot: PlatformSnapshot, now = new Date()) {
  return [...new Set(snapshot.groups.map(g => g.number))].sort((a, b) => a - b).map(number => {
    const groups = snapshot.groups.filter(g => g.number === number && snapshot.weeks.some(w => w.id === g.runId && !["draft", "cancelled"].includes(w.status)));
    const ids = new Set(groups.map(g => g.id));
    const capacity = groups.reduce((n, g) => n + g.capacity, 0);
    const completed = groups.filter(g => snapshot.weeks.some(w => w.id === g.runId && new Date(w.startsAt) <= now));
    const completedIds = new Set(completed.map(g => g.id));
    const attendanceCapacity = completed.reduce((n, g) => n + g.capacity, 0);
    const actual = snapshot.attendance.filter(a => completedIds.has(a.groupId));
    const known = new Set(actual.map(a => `${a.groupId}:${a.memberId}`));
    const attendanceUnknown = snapshot.bookings.filter(b => completedIds.has(b.groupId) && b.status === "confirmed" && !known.has(`${b.groupId}:${b.memberId}`)).length;
    const confirmed = snapshot.bookings.filter(b => ids.has(b.groupId) && b.status === "confirmed").length;
    const present = actual.filter(a => a.outcome === "present").length;
    return { number, capacity, confirmed, present, attendanceUnknown, attendanceRecorded: actual.length,
      bookingUtilisation: capacity ? Math.round(confirmed / capacity * 100) : undefined,
      attendanceUtilisation: attendanceCapacity && actual.length ? Math.round(present / attendanceCapacity * 100) : undefined };
  });
}

export function waitlistAnalytics(snapshot: PlatformSnapshot, runId?: string) {
  const eligibleRuns = new Set(snapshot.weeks.filter(w => !["draft", "cancelled"].includes(w.status)).map(w => w.id));
  const events = snapshot.audit.filter(a => eligibleRuns.has(a.runId) && (!runId || a.runId === runId) && ["waitlistJoined", "promoted", "withdrawn"].includes(a.action));
  const joins = events.filter(a => a.action === "waitlistJoined").length;
  const promotions = events.filter(a => a.action === "promoted").length;
  const queueSizes = events.flatMap(a => a.queueSize === undefined ? [] : [a.queueSize]);
  return {
    joins, promotions, withdrawals: events.filter(a => a.action === "withdrawn").length,
    peakQueue: queueSizes.length ? Math.max(...queueSizes) : undefined,
    promotionRate: joins ? Math.round(promotions / joins * 100) : undefined,
  };
}
