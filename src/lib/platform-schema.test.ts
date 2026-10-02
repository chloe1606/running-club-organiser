import { describe, expect, it } from "vitest";
import { mutationSchema, snapshotSchema } from "./platform-schema";

const fixture = {
  weeks: [{ id: "w", status: "published", startsAt: "2026-10-06T17:30:00Z", bookingOpensAt: "2026-10-02T17:00:00Z", bookingClosesAt: "2026-10-06T16:30:00Z", version: 1 }],
  groups: [{ id: "g", runId: "w", number: 1, paceLabel: "DEMO", capacity: 19, version: 1 }],
  members: [{ id: "m", email: "runner@example.com", name: "Demo Runner", roles: ["runner"], active: true, version: 1 }],
  bookings: [{ id: "b", runId: "w", groupId: "g", memberId: "m", status: "confirmed", source: "member", bookedAt: "2026-10-02T17:00:00Z", version: 1 }],
  attendance: [], audit: [], demo: false,
  config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
};
describe("snapshot integrity", () => {
  it("accepts supported weekly data and legacy capacity on read", () => {
    expect(snapshotSchema.safeParse(fixture).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...fixture, groups: [{ ...fixture.groups[0], capacity: 20 }] }).success).toBe(true);
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
  it("limits editable roles to trusted known roles", () => {
    expect(mutationSchema.safeParse({
      operation: "updateMember", requestId: "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
      memberId: "m", memberVersion: 1, name: "Runner", roles: ["owner"], active: true,
    }).success).toBe(false);
  });
});
