import { describe, expect, it } from "vitest";
import { mutationSchema, snapshotSchema } from "./platform-schema";

const fixture = {
  weeks: [{ id: "w", status: "published", startsAt: "2026-10-06T17:30:00Z", bookingOpensAt: "2026-10-02T17:00:00Z", bookingClosesAt: "2026-10-06T16:30:00Z", version: 1 }],
  groups: Array.from({ length: 13 }, (_, index) => ({ id: index === 0 ? "g" : `g${index + 1}`, runId: "w", number: index + 1, paceLabel: "DEMO", capacity: 19, version: 1 })),
  members: [{ id: "m", email: "runner@example.com", name: "Demo Runner", roles: ["runner"], active: true, version: 1 }],
  bookings: [{ id: "b", runId: "w", groupId: "g", memberId: "m", status: "confirmed", source: "member", bookedAt: "2026-10-02T17:00:00Z", version: 1 }],
  attendance: [], audit: [], demo: false,
  config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
};
describe("snapshot integrity", () => {
  it("accepts supported weekly data and legacy capacity on read", () => {
    expect(snapshotSchema.safeParse(fixture).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...fixture, weeks: [{ ...fixture.weeks[0], location: "Willett Recreation Ground" }] }).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...fixture, groups: fixture.groups.map((group) => ({ ...group, capacity: 20 })) }).success).toBe(true);
  });
  it("rejects duplicate active identities and cross-week references", () => {
    expect(snapshotSchema.safeParse({ ...fixture, bookings: [...fixture.bookings, { ...fixture.bookings[0], id: "other" }] }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, bookings: [{ ...fixture.bookings[0], runId: "other" }] }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, members: [...fixture.members, { ...fixture.members[0], id: "other", email: "RUNNER@example.com" }] }).success).toBe(false);
  });
  it("never accepts fake data on the live boundary", () => {
    expect(snapshotSchema.safeParse({ ...fixture, demo: true }).success).toBe(false);
  });
  it("rejects invalid club zones and booking windows", () => {
    expect(snapshotSchema.safeParse({ ...fixture, config: { ...fixture.config, timeZone: "Invalid/Zone" } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, weeks: [{ ...fixture.weeks[0], bookingClosesAt: fixture.weeks[0].startsAt }] }).success).toBe(false);
  });
  it("rejects duplicate attendance outcomes instead of double-counting people", () => {
    const outcome = { id: "a", runId: "w", groupId: "g", memberId: "m", outcome: "present", recordedAt: "2026-10-06T18:30:00Z" };
    expect(snapshotSchema.safeParse({ ...fixture, attendance: [outcome, { ...outcome, id: "b" }] }).success).toBe(false);
  });
  it("accepts up to twenty uniquely numbered live groups, including decimals", () => {
    expect(snapshotSchema.safeParse({ ...fixture, groups: fixture.groups.slice(1) }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, groups: fixture.groups.map((group) => ({ ...group, number: 1 })) }).success).toBe(false);
    const twentyGroups = Array.from({ length: 20 }, (_, index) => ({
      ...fixture.groups[0], id: index === 0 ? "g" : `g${index + 1}`, number: index + 0.5, capacity: 20,
    }));
    expect(snapshotSchema.safeParse({ ...fixture, groups: twentyGroups }).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...fixture, groups: [...twentyGroups, { ...twentyGroups[19], id: "g21", number: 20 }] }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, groups: twentyGroups.map((group) => ({ ...group, number: 1.5 })) }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, groups: fixture.groups.map((group) => ({ ...group, capacity: 21 })) }).success).toBe(false);
  });
  it("limits editable roles to trusted known roles", () => {
    expect(mutationSchema.safeParse({
      operation: "updateMember", requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
      memberId: "m", memberVersion: 1, name: "Runner", roles: ["owner"], active: true,
    }).success).toBe(false);
  });
  it("accepts optional boolean sweeper choices on runner booking mutations", () => {
    const base = { requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d", runId: "w", runVersion: 1, groupId: "g", groupVersion: 1 };
    expect(mutationSchema.safeParse({ operation: "book", ...base, sweeper: true }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "switchGroup", ...base, sweeper: false }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "book", ...base, sweeper: "yes" }).success).toBe(false);
  });
  it("accepts a group cancellation with a supported reason", () => {
    const base = { requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d", runId: "w", runVersion: 1, groupId: "g", groupVersion: 1 };
    expect(mutationSchema.safeParse({ operation: "cancelGroup", ...base, reason: "low-interest" }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "cancelGroup", ...base, reason: "no-leader" }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "cancelGroup", ...base, reason: "weather" }).success).toBe(false);
  });
  it("accepts None when clearing a leader assignment", () => {
    expect(mutationSchema.safeParse({
      operation: "assignLeader", requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
      runId: "w", runVersion: 1, groupId: "g", groupVersion: 1, memberId: "",
    }).success).toBe(true);
  });
  it("accepts an optional boolean sweeper choice on runner booking mutations", () => {
    const base = { requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d", runId: "w", runVersion: 1, groupId: "g", groupVersion: 1 };
    expect(mutationSchema.safeParse({ operation: "book", ...base, sweeper: true }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "switchGroup", ...base, sweeper: false }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "book", ...base, sweeper: "yes" }).success).toBe(false);
  });
  it("accepts admin location updates with unique saved venues", () => {
    const base = { operation: "updateLocations", requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d", location: "Willett Recreation Ground", locations: ["Willett Recreation Ground"] };
    expect(mutationSchema.safeParse(base).success).toBe(true);
    expect(mutationSchema.safeParse({ ...base, locations: ["Willett Recreation Ground", " willett recreation ground "] }).success).toBe(false);
    expect(mutationSchema.safeParse({ ...base, location: "Unlisted Venue" }).success).toBe(true);
  });
  it("accepts a location on week creation and week-location updates", () => {
    const requestId = "013eb46c-22e2-45db-9c1d-f3bc86a7988d";
    expect(mutationSchema.safeParse({ operation: "createWeek", requestId, date: "2026-10-13", location: "Willett Recreation Ground" }).success).toBe(true);
    expect(mutationSchema.safeParse({ operation: "updateWeekLocation", requestId, runId: "w", runVersion: 1, location: "Willett Recreation Ground" }).success).toBe(true);
  });
});
