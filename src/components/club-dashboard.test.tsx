import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { ClubDashboard } from "./club-dashboard";

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
  it("shows the weekly import command to admins but disables it in demo mode", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-06T12:00:00Z"));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: startsAt, view: "admin" }));
    expect(html).toContain('disabled="">Import weekly leaders</button>');
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