import type { PlatformSnapshot } from "./platform-types";
import type { Run } from "./domain";
import { clubDateTime, nextTuesdayDate, GROUP_CAPACITY } from "./schedule";

export const demoPersonas = {
  runner: "demo-runner",
  leader: "demo-leader",
  admin: "demo-admin",
} as const;

/** Synthetic, reserved-example data. Never a fallback for a live storage failure. */
export function createDemoSnapshot(now = new Date()): PlatformSnapshot {
  const upcoming = nextTuesdayDate(now);
  const members: PlatformSnapshot["members"] = [
    { id: demoPersonas.runner, name: "Alex Morgan", email: "alex@example.test", roles: ["runner"], active: true, version: 1 },
    { id: demoPersonas.leader, name: "Priya Shah", email: "priya@example.test", roles: ["runner", "leader"], active: true, version: 1 },
    { id: demoPersonas.admin, name: "Sam Rivers", email: "sam@example.test", roles: ["runner", "leader", "admin"], active: true, version: 1 },
    ...Array.from({ length: 400 }, (_, i) => ({
      id: `demo-member-${i + 1}`, name: `${["Jamie", "Taylor", "Robin", "Casey", "Jordan", "Charlie"][i % 6]} ${["Brooks", "Patel", "Woods", "Clarke", "Reed"][Math.floor(i / 6) % 5]} ${i + 1}`,
      email: `runner${i + 1}@example.test`, roles: i < 11 ? ["runner", "leader"] : i >= 27 && i <= 40 ? ["runner", "sweeper"] : ["runner"], active: true, version: 1,
    })),
  ];
  const snapshot: PlatformSnapshot = {
    weeks: [], groups: [], bookings: [], members, attendance: [], audit: [],
    config: { location: "Riverside Pavilion, Meadow Lane", startTime: "18:30", timeZone: "Europe/London", demoConfiguration: true },
    demo: true, currentMemberId: demoPersonas.runner,
  };
  const leaders = [demoPersonas.leader, demoPersonas.admin, ...members.slice(3, 14).map(m => m.id)];
  for (let w = 0; w <= 12; w++) {
    const date = new Date(`${upcoming}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7 * w);
    const iso = date.toISOString().slice(0, 10);
    const run: Run = {
      id: `demo-run-${iso}`, startsAt: clubDateTime(iso, "18:30"),
      bookingOpensAt: w === 0 ? new Date(now.getTime() - 86400000).toISOString() : new Date(date.getTime() - 4 * 86400000).toISOString(),
      bookingClosesAt: clubDateTime(iso, "17:30"), status: w ? "archived" : "published", version: 1,
    };
    snapshot.weeks.push(run);
    for (let g = 0; g < 13; g++) {
      const groupId = `${run.id}-group-${g + 1}`;
      snapshot.groups.push({
        id: groupId, runId: run.id, number: g + 1, name: g === 0 ? "Social strides" : g === 12 ? "Fast finishers" : `Pace group ${g + 1}`,
        paceLabel: `${(7.5 - g * .25).toFixed(2)} min/km`, distanceLabel: "Distance to be confirmed",
        capacity: GROUP_CAPACITY, leaderId: leaders[g], sweeperId: g % 3 === 0 ? members[30 + g].id : undefined,
        routeDescription: g % 4 === 0 ? "" : ["Riverside loop via the footbridge. Regroup at every crossing.", "Park paths and canal towpath. Bring a head torch.", "Meadow Lane out-and-back. Stay together at junctions."][g % 3],
        routeNeedsReview: g % 4 === 0, version: 1,
      });
      const occupancy = w === 0 ? [12, 17, 19, 6, 18, 19, 9, 16, 18, 4, 19, 13, 15][g] : Math.min(GROUP_CAPACITY, 8 + ((w * 3 + g) % 13));
      const queue = w === 0 && [2, 5, 10].includes(g) ? 2 + g % 3 : 0;
      const participantIds = [leaders[g], ...(g % 3 === 0 ? [members[30 + g].id] : [])];
      const pool = members.slice(60 + g * 24, 60 + g * 24 + occupancy + queue);
      participantIds.push(...pool.map(m => m.id));
      if (g === (w % 3) && w > 0) participantIds[2] = demoPersonas.runner;
      participantIds.slice(0, occupancy + queue).forEach((memberId, b) => {
        const id = `${groupId}-booking-${b}`;
        snapshot.bookings.push({
          id, runId: run.id, groupId, memberId, status: b < occupancy ? "confirmed" : "waitlisted",
          source: b < (g % 3 === 0 ? 2 : 1) ? "assignment" : "member",
          bookedAt: new Date(new Date(run.bookingOpensAt).getTime() + b * 60000).toISOString(), version: 1,
        });
        // Deliberately leave some historical outcomes unrecorded, never infer attendance.
        if (w && b < occupancy && (b + w) % 7 !== 0) snapshot.attendance.push({
          id: `attendance-${id}`, runId: run.id, groupId, memberId,
          outcome: (b + w) % 9 === 0 ? "absent" : "present", recordedAt: run.startsAt,
        });
        if (!w && b >= occupancy) snapshot.audit.push({
          id: `seed-joined-${id}`, actorId: memberId, memberId, runId: run.id, groupId, action: "waitlistJoined",
          at: new Date(new Date(run.bookingOpensAt).getTime() + b * 60000).toISOString(), requestId: `synthetic-${id}`, queueSize: b - occupancy + 1,
        });
        if (w && g % 4 === 2 && b === 5) {
          snapshot.audit.push(
            { id: `seed-joined-${id}`, actorId: memberId, memberId, runId: run.id, groupId, action: "waitlistJoined", at: new Date(new Date(run.bookingOpensAt).getTime() + b * 60000).toISOString(), requestId: `synthetic-join-${id}`, queueSize: 1 },
            { id: `seed-promoted-${id}`, actorId: "demo-admin", memberId, runId: run.id, groupId, action: "promoted", at: new Date(new Date(run.bookingOpensAt).getTime() + 3600000).toISOString(), requestId: `synthetic-promote-${id}`, queueSize: 0 },
          );
        }
      });
    }
  }
  snapshot.audit.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return snapshot;
}
