import { confirmedCount, type Booking, type Group } from "./domain";

export function canAssignLeaderToGroup(memberId: string, group: Group, groups: Group[], bookings: Booking[]): boolean {
  if (memberId === group.leaderId) return true;
  if (groups.some(other => !other.cancelled && other.runId === group.runId && other.id !== group.id &&
    (other.leaderId === memberId || other.sweeperId === memberId))) return false;
  if (bookings.some(booking => booking.runId === group.runId && booking.groupId !== group.id &&
    booking.memberId === memberId && booking.status !== "cancelled")) return false;

  const alreadyConfirmedHere = bookings.some(booking => booking.runId === group.runId &&
    booking.groupId === group.id && booking.memberId === memberId && booking.status === "confirmed");
  return alreadyConfirmedHere || confirmedCount(group.id, bookings, group) < group.capacity;
}