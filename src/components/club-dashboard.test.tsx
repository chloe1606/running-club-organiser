import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../lib/demo-data";
import { visibleSnapshot } from "../lib/privacy";
import { bookingName, ClubDashboard, runnerStatus } from "./club-dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@clerk/nextjs", () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
}));
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
  it.each([
    ["runs", "/"], ["detail", "/"], ["profile", "/profile"], ["leader", "/leader"], ["admin", "/admin"],
  ] as const)("marks only the current %s navigation tab", (view, href) => {
    const snapshot = createDemoSnapshot(new Date(startsAt));
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: startsAt, view }));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0]).toContain(`href="${href}"`);
    if (view === "admin") expect(html).toContain('<main class="admin-workspace">');
    else expect(html).not.toContain('class="admin-workspace"');
  });
  it("shows actionable readiness for missing leaders, ready drafts, published and closed runs", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(now));
    snapshot.currentMemberId = "demo-admin";
    snapshot.weeks = [snapshot.weeks[0]];
    const run = snapshot.weeks[0];
    run.status = "draft";
    snapshot.groups = snapshot.groups.filter(group => group.runId === run.id).slice(0, 1);
    const group = snapshot.groups[0];
    group.cancelled = false;
    group.leaderId = undefined;
    const readiness = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: now, view: "admin" }))
      .split('aria-label="Run readiness">')[1].split("</ul>")[0];
    expect(readiness()).toContain("Draft — ready to publish; groups without eligible leaders will be marked not running.");
    expect(readiness()).toContain('href="#volunteers"');
    expect(readiness()).toContain('href="#run-controls"');
    expect(readiness()).toContain("bookings will be cancelled on publication");
    group.leaderId = snapshot.members.find(member => member.active && member.roles.includes("leader"))!.id;
    expect(readiness()).toContain("Draft — ready to publish");
    expect(readiness()).toContain('href="#run-controls"');
    snapshot.config.weeklyAutomationEnabled = true;
    expect(readiness()).toContain("Scheduled publication is overdue");
    expect(readiness()).not.toContain("await scheduled publication");
    run.status = "published";
    expect(readiness()).toContain("Ready for runners");
    run.status = "cancelled";
    expect(readiness()).toContain("No changes needed");
    expect(readiness()).not.toContain('href="#run-controls"');
    run.status = "draft";
    run.bookingClosesAt = new Date(now - 1000).toISOString();
    expect(readiness()).toContain("Booking window has closed");
    expect(readiness()).not.toContain("Draft — ready to publish");
  });
  it("offers Restore group only for cancelled groups in future draft or published runs", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(now));
    snapshot.currentMemberId = "demo-admin";
    snapshot.weeks = [snapshot.weeks[0]];
    snapshot.weeks[0].status = "published";
    snapshot.groups = snapshot.groups.filter(group => group.runId === snapshot.weeks[0].id);
    snapshot.groups.forEach(group => { group.cancelled = false; });
    const renderAdmin = () => renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: now, view: "admin" }));
    expect(renderAdmin()).not.toContain(">Restore group</button>");
    snapshot.groups[0].cancelled = true;
    expect(renderAdmin().match(/>Restore group<\/button>/g)).toHaveLength(1);
    snapshot.weeks[0].status = "draft";
    expect(renderAdmin()).toContain(">Restore group</button>");
    snapshot.weeks[0].status = "cancelled";
    expect(renderAdmin()).not.toContain(">Restore group</button>");
    snapshot.weeks[0].status = "archived";
    expect(renderAdmin()).not.toContain(">Restore group</button>");
    snapshot.weeks[0].status = "published";
    snapshot.weeks[0].startsAt = new Date(now - 1).toISOString();
    expect(renderAdmin()).not.toContain(">Restore group</button>");
  });
  it("separates the default venue from the Maps editor and add-location form", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    const mapsForm = html.split('<form class="venue-editor">')[1]?.split("</form>")[0];
    expect(mapsForm).toContain("Edit Maps link for");
    expect(mapsForm).toContain("Google Maps link");
    expect(mapsForm).toContain("Save Maps link");
    expect(mapsForm).not.toContain("Default location");
    expect(html).toContain('<div class="venue-default"><label for="club-location">Default location');
  });
  it("keeps admin add and save buttons in local feedback containers", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    for (const label of ["Add location", "Save Maps link", "Create draft week", "Move runner", "Add trial runner", "Add member"]) {
      expect(html).toMatch(new RegExp(`<div class="action-feedback"><button[^>]*>${label}</button>`));
    }
    expect(html).not.toContain('class="notice" role="status"');
  });
  it("shows Add member in its own panel before the searchable club members panel", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = "demo-admin";
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    const addPanel = html.slice(html.indexOf('<section class="panel member-onboarding-panel">')).split("</section>")[0];
    expect(addPanel).toContain("<summary>Add member</summary>");
    expect(addPanel).not.toContain("Search members");
    expect(html).toMatch(/<\/section><section class="panel"><details[^>]*><summary>Club members<\/summary>/);
    expect(html.indexOf("<summary>Add member</summary>")).toBeLessThan(html.indexOf("<summary>Club members</summary>"));
  });
  it("offers admins a name-only trial runner booking without member details", () => {
    const initialNow = Date.parse("2026-10-06T12:00:00Z");
    const snapshot = createDemoSnapshot(new Date(initialNow));
    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    const trialGroup = snapshot.groups.find(group => group.runId === snapshot.weeks[0].id)!;
    snapshot.bookings.push({ id: "trial-move-option", runId: snapshot.weeks[0].id, groupId: trialGroup.id,
      memberId: "trial-option", guestName: "Taylor Trial", status: "confirmed", source: "trial", bookedAt: snapshot.weeks[0].bookingOpensAt, version: 1 });
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "admin" }));
    expect(html).toContain('<h3 class="subheading">Move a runner</h3>');
    expect(html).toContain("Add a trial runner");
    expect(html).toContain('id="trial-runner-name"');
    expect(html).toContain("Trial runner name");
    expect(html).toContain("Add trial runner");
    expect(bookingName(snapshot, snapshot.bookings.at(-1)!)).toBe("Taylor Trial");
    expect(html).not.toContain("Trial runner email");
  });
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
  it("links upcoming groups in My Running but not historical groups", () => {
    const now = Date.parse("2026-10-06T18:00:00Z");
    const snapshot = createDemoSnapshot(new Date(now));
    const currentRun = snapshot.weeks[0];
    const pastRun = snapshot.weeks[1];
    const currentGroup = snapshot.groups.find(group => group.runId === currentRun.id)!;
    const pastGroup = snapshot.groups.find(group => group.runId === pastRun.id)!;
    snapshot.currentMemberId = snapshot.members[0].id;
    snapshot.bookings = [currentRun, pastRun].map((run, index) => {
      const group = index === 0 ? currentGroup : pastGroup;
      return { id: `profile-${run.id}`, memberId: snapshot.currentMemberId!, runId: run.id, groupId: group.id,
        status: "confirmed" as const, source: "member" as const, bookedAt: run.bookingOpensAt, version: 1 };
    });
    const html = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow: now, view: "profile" }));
    expect(html).toContain(`href="/groups/${currentGroup.id}"`);
    expect(html).not.toContain(`href="/groups/${pastGroup.id}"`);
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
    expect(html).not.toContain("Past runs ·");
    expect(html).not.toContain("Choose a past run");
    expect(html).toContain("Bookings open");
    expect(html).not.toContain(">published</option>");

    snapshot.currentMemberId = snapshot.members.find(member => member.roles.includes("admin"))!.id;
    const adminHtml = renderToStaticMarkup(createElement(ClubDashboard, { initial: snapshot, initialNow, view: "runs" }));
    expect(adminHtml).toContain("Past runs ·");
    expect(adminHtml).toContain("Choose a past run");
    expect(adminHtml.indexOf("Past runs ·")).toBeLessThan(adminHtml.indexOf("Choose your pace group"));
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
    expect(html).toContain("Today&#x27;s run ·");
    expect(html).toContain('class="panel next-tuesday-panel"');
    const advancedStart = html.indexOf('<details class="admin-disclosure advanced-controls"');
    const volunteersStart = html.indexOf('<section class="panel" id="volunteers">');
    const advancedHtml = html.slice(advancedStart, volunteersStart);
    expect(advancedHtml).toContain("<summary>Automation and schedule");
    expect(advancedHtml).toContain("<summary>Create an additional draft manual run</summary>");
    expect(advancedHtml.match(/<details/g)).toHaveLength(advancedHtml.match(/<\/details>/g)?.length ?? 0);
    expect(html.indexOf("<summary>Runner moves &amp; trial runners</summary>")).toBeGreaterThan(volunteersStart);
    expect(html.indexOf("<summary>Group popularity</summary>")).toBeGreaterThan(volunteersStart);
    expect(html).toContain("Leader coverage:");
    expect(html).toContain('aria-label="Run readiness"');
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
  it("shows publication warnings and time controls with stable Admin clock rendering", () => {
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
    expect(html).toContain("groups without eligible leaders will be marked not running");
    expect(html).not.toContain("Publication blocked");
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
  it("offers a signed-out demo view with run details but no runner names or rosters", () => {
    const snapshot = createDemoSnapshot(new Date("2026-10-06T12:00:00Z"));
    const group = snapshot.groups.find(candidate => candidate.runId === snapshot.weeks[0].id)!;
    const privateName = snapshot.members.find(member => snapshot.bookings.some(booking =>
      booking.groupId === group.id && booking.memberId === member.id))!.name;
    const publicSnapshot = visibleSnapshot(snapshot);
    const html = renderToStaticMarkup(createElement(ClubDashboard, {
      initial: publicSnapshot, initialNow: startsAt, view: "detail", groupId: group.id,
    }));
    expect(html).toContain("View as");
    expect(html).toContain('<option value="signed-out" selected="">Signed out</option>');
    expect(html).toContain("Confirmed places");
    expect(html).not.toContain(privateName);
    expect(html).not.toContain("Runners &amp; Waitlist");
    expect(html).not.toContain('class="roster');
    expect(html).not.toContain("<strong>Leader:</strong>");
    expect(html).not.toContain("<h3>Route</h3>");
    expect(html).not.toContain("Riverside loop via the footbridge");
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