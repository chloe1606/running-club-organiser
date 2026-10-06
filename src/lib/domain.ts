export type RunStatus = "draft" | "published" | "cancelled" | "archived";
export type BookingStatus = "confirmed" | "waitlisted" | "cancelled";
export type AssignmentType = "leader" | "sweeper";

export interface Versioned {
  version: number;
}

export interface Run extends Versioned {
  id: string;
  location?: string;
  mapsUrl?: string;
  startsAt: string;
  bookingOpensAt: string;
  bookingClosesAt: string;
  status: RunStatus;
  cancellationReason?: string;
}

export interface Group extends Versioned {
  id: string;
  runId: string;
  number: number;
  paceLabel: string;
  distanceLabel?: string;
  name?: string;
  leaderId?: string;
  sweeperId?: string;
  routeDescription?: string;
  routeNeedsReview?: boolean;
  cancelled?: boolean;
  cancellationReason?: "low-interest" | "no-leader";
  capacity: number;
}

export interface Booking extends Versioned {
  id: string;
  runId: string;
  groupId: string;
  memberId: string;
  status: BookingStatus;
  bookedAt: string;
  source: "member" | "assignment";
}

export interface Assignment extends Versioned {
  id: string;
  runId: string;
  groupId: string;
  memberId: string;
  type: AssignmentType;
}

export class BookingRuleError extends Error {}

export function bookingIsOpen(run: Run, now: Date): boolean {
  return (
    run.status === "published" &&
    now >= new Date(run.bookingOpensAt) &&
    now < new Date(run.bookingClosesAt)
  );
}

export function activeBookings(bookings: Booking[]) {
  return bookings.filter((booking) => booking.status !== "cancelled");
}

export function confirmedCount(groupId: string, bookings: Booking[], group?: Group): number {
  const occupants = new Set(bookings.filter(
    (booking) => booking.groupId === groupId && booking.status === "confirmed",
  ).map((booking) => booking.memberId));
  if (group?.id === groupId) {
    if (group.leaderId) occupants.add(group.leaderId);
    if (group.sweeperId) occupants.add(group.sweeperId);
  }
  return occupants.size;
}

export function nextBookingStatus(group: Group, bookings: Booking[]): BookingStatus {
  return confirmedCount(group.id, bookings, group) < Math.min(group.capacity, 20)
    ? "confirmed"
    : "waitlisted";
}

export function assertCanBook(
  run: Run,
  group: Group,
  bookings: Booking[],
  memberId: string,
  now: Date,
) {
  if (!bookingIsOpen(run, now)) {
    throw new BookingRuleError("Booking is not currently open for this run.");
  }
  if (group.runId !== run.id) {
    throw new BookingRuleError("This group does not belong to the selected run.");
  }
  if (
    activeBookings(bookings).some(
      (booking) => booking.runId === run.id && booking.memberId === memberId,
    )
  ) {
    throw new BookingRuleError("You already have a booking for this run.");
  }
}

export function promoteFirstWaitlisted(
  groupId: string,
  bookings: Booking[],
): Booking | undefined {
  return bookings
    .filter(
      (booking) =>
        booking.groupId === groupId && booking.status === "waitlisted",
    )
    .sort((a, b) => new Date(a.bookedAt).getTime() - new Date(b.bookedAt).getTime() || a.id.localeCompare(b.id))[0];
}

export function assertCanPublish(run: Run, runs: Run[], now: Date) {
  if (run.status !== "draft" || new Date(run.startsAt) <= now) {
    throw new BookingRuleError("Only future draft runs can be published.");
  }
  const hasPublishedFutureRun = runs.some(
    (candidate) =>
      candidate.id !== run.id &&
      candidate.status === "published" &&
      new Date(candidate.startsAt) > now,
  );
  if (hasPublishedFutureRun) {
    throw new BookingRuleError(
      "Another future run is already published. Unpublish or complete it first.",
    );
  }
}
