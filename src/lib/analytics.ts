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
    if (group) counts.set(group.number, (counts.get(group.number) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

export function weeklyAnalytics(snapshot: PlatformSnapshot) {
  return [...snapshot.weeks].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(run => {
    const confirmed = snapshot.bookings.filter(b => b.runId === run.id && b.status === "confirmed");
    const actual = snapshot.attendance.filter(a => a.runId === run.id);
    const present = actual.filter(a => a.outcome === "present").length;
    const absent = actual.filter(a => a.outcome === "absent").length;
    const recorded = new Set(actual.map(a => a.memberId));
    const unknown = confirmed.filter(b => !recorded.has(b.memberId)).length;
    return { run, confirmed: confirmed.length, present, absent, unknown,
      waitlisted: snapshot.bookings.filter(b => b.runId === run.id && b.status === "waitlisted").length,
      attendanceRate: present + absent ? Math.round(present / (present + absent) * 100) : undefined };
  });
}
