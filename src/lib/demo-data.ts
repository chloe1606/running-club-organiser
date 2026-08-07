import type { Booking, Group, Run } from "@/lib/domain";

const runId = "run-2026-08-11";

export const demoRun: Run = {
  id: runId,
  startsAt: "2026-08-11T18:30:00+01:00",
  bookingOpensAt: "2026-08-07T18:00:00+01:00",
  bookingClosesAt: "2026-08-11T17:30:00+01:00",
  status: "published",
  version: 3,
};

export const demoGroups: Group[] = Array.from({ length: 13 }, (_, index) => ({
  id: `group-${index + 1}`,
  runId,
  number: index + 1,
  paceLabel: `${Math.max(4, 7 - index * 0.2).toFixed(1)} min/km`,
  capacity: 20,
  version: 1,
}));

export const demoBookings: Booking[] = [
  {
    id: "booking-1",
    runId,
    groupId: "group-1",
    memberId: "member-1",
    status: "confirmed",
    source: "assignment",
    bookedAt: "2026-08-07T18:00:00+01:00",
    version: 1,
  },
  {
    id: "booking-2",
    runId,
    groupId: "group-1",
    memberId: "member-2",
    status: "confirmed",
    source: "member",
    bookedAt: "2026-08-07T18:02:00+01:00",
    version: 1,
  },
];
