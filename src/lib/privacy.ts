import type { PlatformSnapshot } from "./platform-types";

export function visibleSnapshot(snapshot: PlatformSnapshot, memberId?: string): PlatformSnapshot {
  const member = snapshot.members.find((candidate) => candidate.id === memberId && candidate.active);
  if (!member) {
    return {
      ...snapshot,
      currentMemberId: undefined,
      weeks: snapshot.weeks.filter((week) => week.status !== "draft"),
      groups: snapshot.groups.filter((group) => snapshot.weeks.some((week) => week.id === group.runId && week.status !== "draft"))
        .map((group) => ({ ...group, leaderId: undefined, sweeperId: undefined })),
      bookings: snapshot.bookings.filter((booking) =>
        booking.status !== "cancelled" && snapshot.weeks.some((week) => week.id === booking.runId && week.status === "published"))
        .map((booking, index) => ({
          ...booking, id: `count-${index}`, memberId: `anonymous-${index}`, bookedAt: "", source: "member",
        })),
      members: [], attendance: [], audit: [],
    };
  }
  if (member.roles.includes("admin")) return { ...snapshot, currentMemberId: member.id };
  const published = new Set(snapshot.weeks.filter((week) => week.status === "published").map((week) => week.id));
  const assigned = new Set(snapshot.groups.filter((group) => group.leaderId === member.id).map((group) => group.id));
  const groups = snapshot.groups.filter((group) =>
    snapshot.weeks.some((week) => week.id === group.runId && week.status !== "draft") || assigned.has(group.id));
  const ownWeeks = new Set(snapshot.bookings.filter((booking) => booking.memberId === member.id).map((booking) => booking.runId));
  const bookings = snapshot.bookings.filter((booking) =>
    booking.memberId === member.id || published.has(booking.runId) || assigned.has(booking.groupId));
  return {
    ...snapshot,
    currentMemberId: member.id,
    weeks: snapshot.weeks.filter((week) =>
      week.status !== "draft" || ownWeeks.has(week.id) || groups.some((group) => group.runId === week.id && assigned.has(group.id))),
    groups,
    bookings,
    members: snapshot.members.filter((candidate) => candidate.active || bookings.some((booking) => booking.memberId === candidate.id)).map((candidate) => ({
      ...candidate, email: candidate.id === member.id ? candidate.email : "",
    })),
    attendance: snapshot.attendance.filter((record) =>
      record.memberId === member.id || assigned.has(record.groupId)),
    audit: [],
  };
}
