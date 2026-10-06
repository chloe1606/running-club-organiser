import { z } from "zod";
import { MAX_GROUP_CAPACITY, MAX_GROUP_COUNT } from "./schedule";

const id = z.string().min(1).max(120);
const version = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
const mapsUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com") || url.hostname === "maps.app.goo.gl");
  } catch { return false; }
}, "Use a Google Maps HTTPS link.");
export const memberRoles = z.array(z.enum(["runner", "leader", "sweeper", "admin"])).min(1);

export const snapshotSchema = z.object({
  weeks: z.array(z.object({
    id, location: z.string().trim().min(1).max(120).optional(), mapsUrl: mapsUrl.optional(), startsAt: timestamp, bookingOpensAt: timestamp, bookingClosesAt: timestamp,
    status: z.enum(["draft", "published", "cancelled", "archived"]),
    cancellationReason: z.string().optional(), version,
  })),
  groups: z.array(z.object({
    id, runId: id, number: z.number().positive().max(MAX_GROUP_COUNT),
    paceLabel: z.string().min(1), capacity: z.number().int().min(1).max(MAX_GROUP_CAPACITY), version,
    distanceLabel: z.string().optional(), name: z.string().optional(),
    leaderId: z.string().optional(), sweeperId: z.string().optional(),
    routeDescription: z.string().optional(), routeNeedsReview: z.boolean().optional(),
  })),
  bookings: z.array(z.object({
    id, runId: id, groupId: id, memberId: id, version,
    status: z.enum(["confirmed", "waitlisted", "cancelled"]),
    source: z.enum(["member", "assignment"]), bookedAt: timestamp,
  })),
  members: z.array(z.object({
    id, email: z.email(), name: z.string().min(1), roles: memberRoles,
    active: z.boolean(), version,
  })),
  attendance: z.array(z.object({
    id, runId: id, groupId: id, memberId: id,
    outcome: z.enum(["present", "absent"]), recordedAt: timestamp,
  })),
  audit: z.array(z.object({
    id, runId: z.string(), groupId: z.string().optional(), memberId: z.string().optional(),
    actorId: z.string(), action: z.string(), at: timestamp, requestId: z.string(),
    queueSize: z.number().int().nonnegative().optional(),
  })),
  config: z.object({
    location: z.string().min(1), timeZone: z.string().min(1).refine((timeZone) => {
      try { new Intl.DateTimeFormat("en-GB", { timeZone }).format(); return true; } catch { return false; }
    }),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), demoConfiguration: z.boolean(),
    locations: z.array(z.string().trim().min(1).max(120)).min(1).max(30).optional(),
    locationMaps: z.record(z.string().trim().min(1).max(120), mapsUrl).optional(),
  }),
  demo: z.literal(false), currentMemberId: z.string().optional(),
}).superRefine((snapshot, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  for (const [name, rows] of [
    ["weeks", snapshot.weeks], ["groups", snapshot.groups],
    ["bookings", snapshot.bookings], ["members", snapshot.members],
  ] as const) {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) fail(`Duplicate ${name} identities.`);
  }
  if (new Set(snapshot.members.map((member) => member.email.trim().toLowerCase())).size !== snapshot.members.length) {
    fail("Ambiguous membership email.");
  }
  for (const config of [snapshot.config]) {
    if (config.locations && (new Set(config.locations.map((location) => location.toLowerCase())).size !== config.locations.length ||
      (config.locations.length > 0 && !config.locations.includes(config.location)))) fail("Club location must be unique and include the selected venue.");
    if (config.locationMaps && Object.keys(config.locationMaps).some((location) => config.locations && !config.locations.includes(location))) {
      fail("Each Google Maps link must refer to a saved venue.");
    }
  }
  const weeks = new Map(snapshot.weeks.map((week) => [week.id, week]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  const members = new Set(snapshot.members.map((member) => member.id));
  for (const week of snapshot.weeks) {
    if (Date.parse(week.bookingOpensAt) >= Date.parse(week.bookingClosesAt) ||
        Date.parse(week.bookingClosesAt) >= Date.parse(week.startsAt)) fail("Invalid booking window.");
    if (week.status === "draft" || week.status === "published") {
      const groups = snapshot.groups.filter((group) => group.runId === week.id);
      if (!groups.length || groups.length > MAX_GROUP_COUNT || new Set(groups.map((group) => group.number)).size !== groups.length) {
        fail("Every live week must have 1–20 groups with unique numbers.");
      }
    }
  }
  for (const group of snapshot.groups) {
    if (!weeks.has(group.runId)) fail("Group references an unknown week.");
    if ((group.leaderId && !members.has(group.leaderId)) || (group.sweeperId && !members.has(group.sweeperId))) fail("Unknown leadership identity.");
  }
  const active = new Set<string>();
  for (const booking of snapshot.bookings) {
    if (groups.get(booking.groupId)?.runId !== booking.runId || !members.has(booking.memberId)) fail("Invalid booking reference.");
    if (booking.status !== "cancelled") {
      const key = JSON.stringify([booking.runId, booking.memberId]);
      if (active.has(key)) fail("Multiple active bookings for one member in a week.");
      active.add(key);
    }
  }
  const outcomes = new Set<string>();
  for (const record of snapshot.attendance) {
    if (groups.get(record.groupId)?.runId !== record.runId || !members.has(record.memberId)) fail("Invalid attendance reference.");
    const key = JSON.stringify([record.runId, record.memberId]);
    if (outcomes.has(key)) fail("Multiple attendance outcomes for one member in a week.");
    outcomes.add(key);
  }
});

const base = { requestId: z.uuid() };
const week = { ...base, runId: id, runVersion: version };
const group = { ...week, groupId: id, groupVersion: version };
export const mutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("book"), ...group, sweeper: z.boolean().optional() }),
  z.object({ operation: z.literal("leave"), ...week }),
  z.object({ operation: z.literal("switchGroup"), ...group, sweeper: z.boolean().optional() }),
  z.object({ operation: z.literal("moveRunner"), ...group, memberId: id }),
  z.object({ operation: z.literal("createWeek"), ...base, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), copyFromRunId: id.optional(), location: z.string().trim().min(1).max(120).optional() }),
  z.object({ operation: z.literal("updateWeekLocation"), ...week, location: z.string().trim().min(1).max(120) }),
  z.object({ operation: z.literal("publishRun"), ...week }),
  z.object({ operation: z.literal("cancelRun"), ...week, cancellationReason: z.string().trim().min(3).max(500) }),
  z.object({ operation: z.literal("archiveRun"), ...week }),
  z.object({ operation: z.literal("updateRoute"), ...group, routeDescription: z.string().trim().min(3).max(4000) }),
  z.object({ operation: z.literal("assignLeader"), ...group, memberId: id }),
  z.object({ operation: z.literal("assignSweeper"), ...group, memberId: z.string().max(120).optional() }),
  z.object({ operation: z.literal("recordAttendance"), ...group, memberId: id, outcome: z.enum(["present", "absent"]) }),
  z.object({ operation: z.literal("updateMember"), ...base, memberId: id, memberVersion: version, name: z.string().trim().min(1).max(100), roles: memberRoles, active: z.boolean() }),
  z.object({ operation: z.literal("updateLocations"), ...base, location: z.string().trim().min(1).max(120), locations: z.array(z.string().trim().min(1).max(120)).min(1).max(30).superRefine((locations, context) => {
    if (new Set(locations.map((location) => location.toLowerCase())).size !== locations.length) context.addIssue({ code: "custom", message: "Venue names must be unique." });
  }), locationMaps: z.record(z.string().trim().min(1).max(120), mapsUrl).optional() }),
]);

export type ClubMutation = z.infer<typeof mutationSchema>;
