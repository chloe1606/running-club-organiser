import { describe, expect, it } from "vitest";
import {
  assertCanBook,
  assertCanPublish,
  confirmedCount,
  nextBookingStatus,
  promoteFirstWaitlisted,
  type Booking,
  type Group,
  type Run,
} from "./domain";

const run: Run = {
  id: "run",
  startsAt: "2026-08-11T18:30:00Z",
  bookingOpensAt: "2026-08-01T00:00:00Z",
  bookingClosesAt: "2026-08-11T17:30:00Z",
  status: "published",
  version: 1,
};
const group: Group = { id: "group", runId: "run", number: 1, paceLabel: "5:00", capacity: 1, version: 1 };
const confirmed: Booking = { id: "a", runId: "run", groupId: "group", memberId: "one", status: "confirmed", source: "member", bookedAt: "2026-08-01T00:00:00Z", version: 1 };

describe("booking rules", () => {
  it("waitlists after capacity is reached", () => {
    expect(nextBookingStatus(group, [confirmed])).toBe("waitlisted");
    expect(confirmedCount(group.id, [confirmed])).toBe(1);
  });

  it("promotes the earliest waitlisted runner", () => {
    const second = { ...confirmed, id: "b", memberId: "two", status: "waitlisted" as const, bookedAt: "2026-08-01T02:00:00Z" };
    const first = { ...second, id: "c", memberId: "three", bookedAt: "2026-08-01T01:00:00Z" };
    expect(promoteFirstWaitlisted(group.id, [second, first])?.id).toBe("c");
  });

  it("rejects a duplicate booking and a second published future run", () => {
    expect(() => assertCanBook(run, group, [confirmed], "one", new Date("2026-08-02T00:00:00Z"))).toThrow("already have");
    expect(() => assertCanPublish({ ...run, id: "next", status: "draft" }, [run], new Date("2026-08-02T00:00:00Z"))).toThrow("already published");
  });

  it("counts assignment occupants once and enforces the nineteen-person ceiling", () => {
    expect(confirmedCount(group.id, [confirmed], { ...group, leaderId: "one", sweeperId: "two" })).toBe(2);
    const nineteen = Array.from({ length: 19 }, (_, index) => ({ ...confirmed, id: `${index}`, memberId: `${index}` }));
    expect(nextBookingStatus({ ...group, capacity: 20 }, nineteen)).toBe("waitlisted");
  });

  it("breaks promotion ties by ID, including equivalent timestamp offsets", () => {
    const first = { ...confirmed, id: "a", status: "waitlisted" as const, bookedAt: "2026-08-01T01:00:00+01:00" };
    const second = { ...first, id: "z", bookedAt: "2026-08-01T00:00:00Z" };
    expect(promoteFirstWaitlisted(group.id, [second, first])?.id).toBe("a");
  });

  it("does not publish past or non-draft runs", () => {
    expect(() => assertCanPublish(run, [], new Date("2026-08-02T00:00:00Z"))).toThrow("draft");
    expect(() => assertCanPublish({ ...run, status: "draft" }, [], new Date("2026-08-12T00:00:00Z"))).toThrow("future");
  });
});
