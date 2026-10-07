import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { ClubDashboard, runnerStatus } from "./club-dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/domain", () => import("../lib/domain"));
vi.mock("@/lib/analytics", () => import("../lib/analytics"));
vi.mock("@/lib/locations", () => import("../lib/locations"));
vi.mock("@/lib/leader-availability", () => import("../lib/leader-availability"));
vi.mock("@/lib/schedule", () => import("../lib/schedule"));

const startsAt = Date.parse("2026-10-06T18:00:00Z");

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(initialNow: number) {
  const snapshot = createDemoSnapshot(new Date("2026-10-06T12:00:00Z"));
  const run = snapshot.weeks[0];
  run.startsAt = new Date(startsAt).toISOString();
  run.status = "published";
  snapshot.weeks = [run];
  const group = snapshot.groups.find(candidate => candidate.runId === run.id && candidate.leaderId)!;
  snapshot.currentMemberId = group.leaderId;
  return renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "leader" }));
}

describe("leader attendance clock", () => {
  it("counts confirmed profile runs without attendance and excludes waitlisted or cancelled runs", () => {
    const snapshot = createDemoSnapshot(new Date(startsAt));
    const memberId = snapshot.currentMemberId!;
    const run = snapshot.weeks[0];
    const group = snapshot.groups.find(candidate => candidate.runId === run.id && !candidate.cancelled)!;
    snapshot.bookings = [{ id: "profile-confirmed", memberId, runId: run.id, groupId: group.id,
      status: "confirmed", source: "member", bookedAt: run.bookingOpensAt, version: 1 }];
    snapshot.attendance = [];
    group.leaderId = memberId;
    const renderProfile = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: startsAt, view: "profile" }));
    expect(renderProfile()).toContain("Runs attended</span><strong>1</strong>");
    expect(renderProfile()).toContain(`Favourite group</span><strong>Group ${group.number}</strong>`);
    expect(renderProfile()).toContain("Runs led</span><strong>1</strong>");
    snapshot.bookings[0].status = "waitlisted";
    expect(renderProfile()).toContain("Runs attended</span><strong>0</strong>");
    expect(renderProfile()).toContain("Favourite group</span><strong>Not yet</strong>");
    snapshot.bookings[0].status = "confirmed";
    group.cancelled = true;
    expect(renderProfile()).toContain("Runs attended</span><strong>0</strong>");
    expect(renderProfile()).toContain("Runs led</span><strong>0</strong>");
    group.cancelled = false;
    run.status = "cancelled";
    expect(renderProfile()).toContain("Runs attended</span><strong>0</strong>");
    expect(renderProfile()).toContain("Runs led</span><strong>0</strong>");
  });
  it("prioritises a bookable runner week over earlier future closed and historical weeks", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    const current = snapshot.weeks[0];
    const earlier = { ...current, id: "earlier-closed", startsAt: "2026-10-06T13:00:00Z", bookingClosesAt: "2026-10-06T11:00:00Z" };
    snapshot.weeks.unshift(earlier);
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "runs" }));
    const picker = html.split('<select id="week"')[1].split("</select>")[0];
    expect(picker).toContain(`value="${current.id}" selected=""`);
    expect(picker).not.toContain("archived");
    expect(html).toContain("Past runs ·");
    expect(html).toContain("Choose a past run");
    expect(html).toContain("Bookings open");
    expect(html).not.toContain(">published</option>");
  });

  it("uses public booking labels at exact opening and closing boundaries", () => {
    const run = createDemoSnapshot(new Date("2026-10-06T12:00:00Z")).weeks[0];
    expect(runnerStatus(run, Date.parse(run.bookingOpensAt) - 1)).toBe("Bookings closed");
    expect(runnerStatus(run, Date.parse(run.bookingOpensAt))).toBe("Bookings open");
    expect(runnerStatus(run, Date.parse(run.bookingClosesAt))).toBe("Bookings closed");
    expect(runnerStatus({ ...run, status: "cancelled" }, Date.parse(run.bookingOpensAt))).toBe("Cancelled");
  });

  it("reports truthful health, selected readiness and clickable drafts without claiming installation", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.demo = false;
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    snapshot.config.weeklyAutomationEnabled = true;
    snapshot.weeks[0].status = "draft";
    const renderAdmin = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    const html = renderAdmin();
    expect(html).toContain("Next Tuesday ·");
    expect(html).toContain("Leader readiness:");
    expect(html).toContain("<dt>Last successful check</dt>");
    expect(html).toContain("Automation and schedule");
    expect(html).toContain("Selected run overrides");
    expect(html).toContain("Not recorded");
    expect(html).toContain("Timer operation is unverified");
    expect(html).toContain('aria-pressed="true"');
    snapshot.schedulerHealth = { lastSuccessfulCheckAt: "2026-10-06T11:00:00Z" };
    expect(renderAdmin()).toContain("Scheduler check is overdue");
    snapshot.schedulerHealth.lastSuccessfulCheckAt = "2026-10-06T11:45:00Z";
    expect(renderAdmin()).toContain("does not verify that a timer remains installed");
  });

  it("renders booking popularity independently of attendance and excludes cancelled selected groups", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    const selectedRun = snapshot.weeks[0];
    const cancelledGroup = snapshot.groups.find(group => group.runId === selectedRun.id)!;
    cancelledGroup.cancelled = true;
    cancelledGroup.paceLabel = "CANCELLED DEMAND ROW";
    const adminHtml = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    const html = adminHtml();
    expect(html).toContain("Group popularity</summary>");
    expect(html).toContain("Average confirmed bookings by group");
    expect(html).toContain("Avg. confirmed bookings");
    expect(html).toContain("Avg. retained waitlist");
    expect(html).toContain("Completed weeks");
    expect(html).toContain("Confirmed bookings include assigned volunteers");
    expect(html).toContain("Zero-booking weeks count in averages");
    expect(html).toContain("All available completed published/archived weeks");
    expect(html).not.toContain("Attendance, not assumptions");
    expect(html).not.toContain("Recorded present");
    expect(html).not.toContain("Avg. recorded attendees");
    expect(html).not.toContain("<th>Present</th>");
    expect(html).not.toContain("<th>Absent</th>");
    expect(html).not.toContain("<th>Unknown</th>");
    const demandTable = html.split("<caption>Selected week: group demand</caption>")[1].split("</table>")[0];
    expect(demandTable).not.toContain("CANCELLED DEMAND ROW");
    expect(demandTable).toContain("Current waitlist");
    expect(html).toContain("Recorded waitlist flow");
    snapshot.attendance.forEach(record => { record.outcome = "absent"; });
    expect(adminHtml()).toBe(html);
    snapshot.attendance = [];
    expect(adminHtml()).toBe(html);
  });
  it("shows an empty popularity state without claiming missing attendance is zero", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    snapshot.weeks.forEach(run => { run.status = "draft"; });
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    expect(html).toContain("No completed running groups are available yet.");
    expect(html).toContain("Booking fill</span><strong>Not available</strong>");
    expect(html).not.toContain("Average recorded attendees");
  });
  it("shows blocked automation and time controls with stable Admin clock rendering", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-06T12:00:00Z"));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    snapshot.config.weeklyAutomationEnabled = true;
    snapshot.weeks[0].status = "draft";
    const group = snapshot.groups.find(group => group.runId === snapshot.weeks[0].id && !group.cancelled)!;
    delete group.leaderId;
    const initialNow = Date.parse("2026-10-04T18:00:00Z");
    const adminHtml = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const html = adminHtml();
    expect(html).toContain("Publication blocked");
    expect(html).toContain("needs an eligible leader");
    expect(html).toContain("Start time for this week");
    expect(html).toContain("Sunday publication time");
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    expect(adminHtml()).toBe(html);
  });
  it("hides the live weekly import in demo mode and wires member onboarding", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-06T12:00:00Z"));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: startsAt, view: "admin" }));
    expect(html).not.toContain("Preview import");
    expect(html).toContain("Add member</summary>");
    snapshot.demo = false;
    const liveHtml = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: startsAt, view: "admin" }));
    expect(liveHtml).toContain("Import weekly leaders</summary>");
    expect(liveHtml).toContain("Preview import");
    expect(liveHtml).not.toContain("Existing leaders in listed groups may be replaced");
  });
  it("renders identical initial HTML despite different server and browser wall clocks", () => {
    vi.setSystemTime(new Date(startsAt - 60_000));
    const serverHtml = render(startsAt);
    vi.setSystemTime(new Date(startsAt + 86_400_000));
    expect(render(startsAt)).toBe(serverHtml);
    expect(serverHtml).toContain('aria-pressed="false">Present</button>');
    expect(serverHtml).not.toContain('disabled="" aria-pressed="false">Present</button>');
  });

  it("keeps attendance disabled before the shared clock reaches the run start", () => {
    vi.setSystemTime(new Date(startsAt + 86_400_000));
    expect(render(startsAt - 1)).toContain('disabled="" aria-pressed="false">Present</button>');
    expect(render(startsAt)).not.toContain('disabled="" aria-pressed="false">Present</button>');
  });
});