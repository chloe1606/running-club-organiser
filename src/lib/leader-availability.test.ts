import { describe, expect, it } from "vitest";
import type { Booking, Group } from "./domain";
import { canAssignLeaderToGroup } from "./leader-availability";

const group = (id: string, values: Partial<Group> = {}): Group => ({
  id, runId: "run", number: 1, paceLabel: "Easy", capacity: 2, version: 1, ...values,
});
const booking = (id: string, memberId: string, groupId: string, status: Booking["status"] = "confirmed"): Booking => ({
  id, runId: "run", groupId, memberId, status, source: "member", bookedAt: "2026-10-01T12:00:00.000Z", version: 1,
});

describe("leader availability", () => {
  it("allows a free leader when the target group has capacity", () => {
    expect(canAssignLeaderToGroup("leader", group("target"), [group("target"), group("other")], [])).toBe(true);
  });

  it("rejects leaders assigned or booked in another group that week", () => {
    const target = group("target");
    expect(canAssignLeaderToGroup("leader", target, [target, group("other", { leaderId: "leader" })], [])).toBe(false);
    expect(canAssignLeaderToGroup("leader", target, [target, group("other")], [booking("b", "leader", "other")])).toBe(false);
  });

  it("rejects adding a leader when the group is full unless they already have a confirmed place there", () => {
    const target = group("target");
    const full = [booking("b1", "runner-1", "target"), booking("b2", "runner-2", "target")];
    expect(canAssignLeaderToGroup("leader", target, [target], full)).toBe(false);
    expect(canAssignLeaderToGroup("runner-1", target, [target], full)).toBe(true);
  });
});