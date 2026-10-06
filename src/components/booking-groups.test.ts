import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { BookingGroups } from "./booking-groups";
import type { PlatformSnapshot } from "../lib/platform-types";

function fixture() {
  const snapshot = createDemoSnapshot(new Date());
  const run = snapshot.weeks[0];
  const groups = snapshot.groups.filter(g => g.runId === run.id);
  return { snapshot, run, groups };
}
function render(snapshot: PlatformSnapshot) {
  const run = snapshot.weeks[0];
  return renderToStaticMarkup(createElement(BookingGroups, {
    snapshot, run, groups: snapshot.groups.filter(g => g.runId === run.id), pending: false, mutate: vi.fn(),
  }));
}

describe("runner group UI", () => {
  it("renders all 13 groups with capacities, leader names and explicit availability labels", () => {
    const { snapshot } = fixture();
    const html = render(snapshot);
    expect(html.match(/<article/g)).toHaveLength(13);
    expect(html).toContain('class="availability green">7 places left');
    expect(html).toContain('class="availability amber">2 places left');
    expect(html).toContain('class="availability full">Full · waitlist');
    expect(html).toContain("19/19 confirmed · Waitlist: 4");
    expect(html).toContain("Priya Shah");
    expect(html).toContain("Distance to be confirmed");
    expect(html).toContain("Join waitlist");
    expect(html).toContain("Join this group");
  });
  it("shows an optional sweeper checkbox only to a member with the sweeper role", () => {
    const { snapshot } = fixture();
    snapshot.members.find(member => member.id === snapshot.currentMemberId)!.roles.push("sweeper");
    expect(render(snapshot)).toContain("Volunteer as this group’s sweeper");
    expect(render(fixture().snapshot)).not.toContain("Volunteer as this group’s sweeper");
  });
  it("shows the runner’s actual personal queue position, not a confirmed place", () => {
    const { snapshot, run, groups } = fixture();
    snapshot.bookings.push({
      id: "own-queue", runId: run.id, groupId: groups[2].id, memberId: snapshot.currentMemberId!,
      status: "waitlisted", source: "member", version: 1,
      bookedAt: new Date(new Date(run.bookingOpensAt).getTime() + 86400000).toISOString(),
    });
    const html = render(snapshot);
    expect(html).toContain("waitlist position #5 (not confirmed)");
    expect(html).toContain("Leave this group");
    expect(html).toContain("Switch to this group");
    expect(html).toContain("Switch to waitlist");
    expect(html).not.toContain("Join this group");
  });
  it("offers optional sweeper volunteering only to members with the sweeper role", () => {
    const { snapshot } = fixture();
    snapshot.members.find(member => member.id === snapshot.currentMemberId)!.roles.push("sweeper");
    expect(render(snapshot)).toContain("Volunteer as this group’s sweeper");
    expect(render(fixture().snapshot)).not.toContain("Volunteer as this group’s sweeper");
  });
  it("limits public cards to summaries with sign-in links, never a roster or email", () => {
    const { snapshot } = fixture();
    snapshot.currentMemberId = undefined;
    snapshot.members = [];
    const html = render(snapshot);
    expect(html).toContain('href="/auth/signin"');
    expect(html).toContain("Sign in to book");
    expect(html).toContain("Sign in for group details");
    expect(html).not.toContain("Route, runners &amp; waitlist");
    expect(html).not.toContain("@example.test");
    expect(html).not.toContain("<button");
  });
  it("clearly closes historical weeks and disables all booking actions", () => {
    const { snapshot } = fixture();
    snapshot.weeks[0].status = "archived";
    const html = render(snapshot);
    expect(html).toContain("Booking is closed for this week.");
    expect(html.match(/disabled=""/g)).toHaveLength(13);
  });
  it("protects assigned volunteers from self-service leaving and switching", () => {
    const { snapshot } = fixture();
    snapshot.currentMemberId = "demo-leader";
    const html = render(snapshot);
    expect(html).toContain("assigned volunteer; ask an administrator to change this assignment.");
    expect(html.match(/disabled=""/g)).toHaveLength(13);
    expect(html).not.toContain("@example.test");
  });
  it("shows zero active bookings for cancelled groups despite preserved volunteer fields", () => {
    const { snapshot, run, groups } = fixture();
    run.status = "cancelled";
    snapshot.bookings.filter(b => b.runId === run.id).forEach(b => { b.status = "cancelled"; });
    expect(groups.some(g => g.leaderId || g.sweeperId)).toBe(true);
    const html = render(snapshot);
    expect(html.match(/0\/19 confirmed · Waitlist: 0/g)).toHaveLength(13);
    expect(html).not.toContain("1/19 confirmed");
  });
});
