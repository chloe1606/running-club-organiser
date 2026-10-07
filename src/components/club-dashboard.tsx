"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Group, Run } from "@/lib/domain";
import { bookingIsOpen, confirmedCount } from "@/lib/domain";
import type { ClubMember, PlatformSnapshot } from "@/lib/platform-types";
import { bookingPopularity, queuePosition, waitlistAnalytics, weeksLedBy } from "@/lib/analytics";
import { BookingGroups } from "./booking-groups";
import { CancelRun } from "./cancel-run";
import { SignIn, SignOut } from "./auth-controls";
import { ClubBrand } from "./club-brand";
import { DEFAULT_LOCATIONS, DEFAULT_LOCATION_MAPS } from "@/lib/locations";
import { RouteDescription } from "./route-description";
import { SearchableSelect } from "./searchable-select";
import { MemberOnboarding } from "./member-onboarding";
import { WeeklyLeaderImport } from "./weekly-leader-import";
import { canAssignLeaderToGroup } from "@/lib/leader-availability";
import { clubDate, clubDateTime, nextTuesdayDate, publicationBlockers, sundayPublicationAt, updateRunTime } from "@/lib/schedule";

export type Mutate = (operation: string, payload: Record<string, unknown>) => Promise<void>;
export function dateLabel(value: string, timeZone = "Europe/London") {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}
export function memberName(snapshot: PlatformSnapshot, id?: string) {
  return snapshot.members.find(m => m.id === id)?.name ?? (id ? "Club member" : "To be assigned");
}

function mapsUrl(location: string, savedUrl?: string) {
  if (savedUrl) return savedUrl;
  return DEFAULT_LOCATION_MAPS[location] ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

export function runnerStatus(run: Run, now: number) {
  return run.status === "cancelled" ? "Cancelled" : bookingIsOpen(run, new Date(now)) ? "Bookings open" : "Bookings closed";
}

export function ClubDashboard({ initial, initialNow, view = "runs", groupId }: {
  initial: PlatformSnapshot; initialNow: number; view?: "runs" | "leader" | "admin" | "profile" | "detail"; groupId?: string;
}) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const mountedAt = performance.now();
    const timer = window.setInterval(() => setNow(initialNow + performance.now() - mountedAt), 1000);
    return () => window.clearInterval(timer);
  }, [initialNow]);
  useEffect(() => {
    document.querySelectorAll<HTMLDetailsElement>(".admin-disclosure").forEach(disclosure => { disclosure.open = false; });
  }, []);
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const sortedWeeks = [...snapshot.weeks].sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const leaderWeeks = [...weeksLedBy(snapshot, snapshot.currentMemberId)].sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const availableWeeks = view === "leader" ? leaderWeeks : sortedWeeks;
  const [selectedId, setSelectedId] = useState(
    initial.groups.find(g => g.id === groupId)?.runId ??
    (view === "admin" ? [...initial.weeks].filter(r => ["draft", "published"].includes(r.status) && Date.parse(r.startsAt) > initialNow).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]?.id : undefined) ??
    (view === "runs" ? [...initial.weeks].filter(r => bookingIsOpen(r, new Date(initialNow))).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]?.id : undefined) ??
    [...(view === "leader" ? weeksLedBy(initial, initial.currentMemberId) : initial.weeks)].filter(r => r.status === "published" && Date.parse(r.startsAt) > initialNow).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]?.id ??
    (view === "leader" ? weeksLedBy(initial, initial.currentMemberId) : initial.weeks).find(r => r.status === "published")?.id ??
    (view === "leader" ? weeksLedBy(initial, initial.currentMemberId) : sortedWeeks)[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState(false);
  const uncertainRequests = useRef(new Map<string, { requestId: string; operation: string; payload: Record<string, unknown> }>());
  const [retry, setRetry] = useState<{ operation: string; payload: Record<string, unknown> }>();
  const current = snapshot.members.find(m => m.id === snapshot.currentMemberId);
  const admin = current?.roles.includes("admin");
  const leader = current?.roles.includes("leader");
  const effectiveSelectedId = availableWeeks.some(week => week.id === selectedId) ? selectedId : availableWeeks[0]?.id ?? "";
  const run = availableWeeks.find(r => r.id === effectiveSelectedId);
  const runnerView = view === "runs" || view === "detail";
  const activeWeeks = availableWeeks.filter(week => Date.parse(week.startsAt) >= now && week.status !== "archived").sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const historicalWeeks = availableWeeks.filter(week => !activeWeeks.some(active => active.id === week.id));
  const pickerWeeks = view === "runs" ? [...activeWeeks, ...(run && historicalWeeks.includes(run) ? [run] : [])] : availableWeeks;
  const meetingLocation = run?.location ?? snapshot.config.location;
  const mutate: Mutate = async (operation, payload) => {
    if (pending) return;
    const intent = JSON.stringify([operation, Object.keys(payload).filter(key => !key.endsWith("Version")).sort().map(key => [key, payload[key]])]);
    const existing = uncertainRequests.current.get(intent);
    const request = existing ?? { operation, payload, requestId: crypto.randomUUID() };
    if (!existing) uncertainRequests.current.clear();
    uncertainRequests.current.set(intent, request);
    setPending(true); setMessage(""); setFailure(false);
    try {
      const response = await fetch("/api/platform", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: request.operation, requestId: request.requestId, ...request.payload }) });
      if (response.status === 401) { uncertainRequests.current.delete(intent); setRetry(undefined); router.push("/auth/signin"); return; }
      if (response.status >= 400 && response.status < 500) uncertainRequests.current.delete(intent);
      const body = await response.json();
      if (response.status === 409 && body.data) setSnapshot(body.data);
      if (!response.ok || !body.data) throw new Error(body.message ?? body.error ?? "The change could not be saved.");
      uncertainRequests.current.delete(intent); setRetry(undefined);
      setSnapshot(body.data);
      setMessage("Saved. Your club data is up to date.");
    } catch (error) {
      const uncertain = uncertainRequests.current.has(intent);
      setRetry(uncertain ? request : undefined);
      setFailure(true); setMessage((error instanceof Error ? error.message : "Service unavailable.") + (uncertain ? " Save status is uncertain. Retry below to reuse the same request safely." : ""));
      // Refetch on conflict, never optimistically claim the mutation succeeded.
      try {
        const response = await fetch("/api/platform", { cache: "no-store" });
        if (response.ok) {
          const body = await response.json();
          if (body.data) setSnapshot(body.data);
          else if (body.weeks) setSnapshot(body);
        }
      } catch { /* Preserve last known data and the visible error. */ }
    } finally { setPending(false); }
  };
  async function changePersona(persona: string) {
    setPending(true);
    try {
      const response = await fetch("/api/demo/persona", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona }) });
      if (!response.ok) throw new Error("Could not change demo persona.");
      router.push("/");
      router.refresh();
    } catch (error) { setFailure(true); setMessage(error instanceof Error ? error.message : "Demo unavailable."); }
    finally { setPending(false); }
  }
  const headings = { runs: "Club Runs", leader: "Leaders", admin: "Admins", profile: "My Running", detail: "Group Details" };
  const groups = snapshot.groups.filter(g => g.runId === run?.id).sort((a, b) => a.number - b.number);
  return <main>
    <nav className="club-nav" aria-label="Club navigation">
      <ClubBrand />
      <div className="nav-links">
        <Link href="/">Club Runs</Link>
        {snapshot.currentMemberId && <Link href="/profile">My Running</Link>}
        {(leader || admin) && <Link href="/leader">Leaders</Link>}
        {admin && <Link href="/admin">Admin</Link>}
        {!snapshot.demo && (snapshot.currentMemberId ? <SignOut /> : <SignIn />)}
      </div>
    </nav>
    {snapshot.demo && <aside className="demo-banner" aria-label="Demo mode">
      <div><strong>Interactive demo</strong> · Synthetic members and attendance. Changes are process-local and reset on restart. Location, time and distances are demonstration scaffolding, not club facts.</div>
      <label>Try a role <select disabled={pending} value={admin ? "admin" : leader ? "leader" : "runner"} onChange={e => void changePersona(e.target.value)}>
        <option value="runner">Runner</option><option value="leader">Leader</option><option value="admin">Administrator</option>
      </select></label>
    </aside>}
    {!snapshot.demo && snapshot.config.demoConfiguration && <p className="notice">Meeting settings are unconfirmed demonstration scaffolding. An administrator must set the club’s agreed location, start time and distances in the workbook before relying on them.</p>}
    <header className={`hero ${view === "admin" ? "workspace-header" : ""}`}>
      <p className="eyebrow">{view === "runs" ? "A little pace. A lot of community." : view === "profile" ? current?.name ?? "Member profile" : `${view} workspace`}</p>
      <h1>{headings[view]}</h1>
      {view !== "admin" && <>
      <p className="intro">Tuesday evenings. Shared miles. A group for every pace.</p>
      <div className="meeting"><span className="meeting-pin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.8"/></svg></span><span><a className="meeting-place" href={mapsUrl(meetingLocation, run?.mapsUrl ?? snapshot.config.locationMaps?.[meetingLocation])} target="_blank" rel="noreferrer">{meetingLocation || "Meeting point to be confirmed"} <span className="meeting-map-hint">Open in Google Maps</span></a><br /><strong>{run ? new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(run.startsAt)) : snapshot.config.startTime} · {snapshot.config.timeZone}</strong></span></div>
      </>}
    </header>
    {message && <p className={failure ? "notice error" : "notice"} role={failure ? "alert" : "status"}>{message}</p>}
    {retry && <p><button disabled={pending} className="secondary" onClick={() => void mutate(retry.operation, retry.payload)}>Retry last save safely</button></p>}
    {(view !== "runs" && !snapshot.currentMemberId) ? <section className="panel"><h2>Members only</h2><p>Sign in to see your club workspace.</p><Link className="button" href="/auth/signin">Sign in</Link></section> :
      view === "admin" && !admin ? <p className="notice">Administrator access is required.</p> :
      view === "leader" && !leader && !admin ? <p className="notice">Leader access is required.</p> :
      view === "profile" ? <Profile snapshot={snapshot} /> : <>
        <section className="week-bar" aria-label="Selected week">
          <label htmlFor="week">Run week<select id="week" disabled={view === "detail" || (view === "leader" && !leaderWeeks.length)} value={effectiveSelectedId} onChange={e => setSelectedId(e.target.value)}>
            {pickerWeeks.map(w => <option key={w.id} value={w.id}>{dateLabel(w.startsAt, snapshot.config.timeZone)} · {runnerView ? runnerStatus(w, now) : w.status}</option>)}
          </select></label>
          {run && <div><span className={`badge ${run.status}`}>{runnerView ? runnerStatus(run, now) : run.status}</span><p>{run.status === "published" ? `Booking ${Date.parse(run.bookingClosesAt) <= now ? "closed" : "closes"} ${dateLabel(run.bookingClosesAt, snapshot.config.timeZone)} at ${new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(run.bookingClosesAt))}` : "Historical and draft weeks are not open for bookings."}</p></div>}
        </section>
        {run?.cancellationReason && <p className="notice error"><strong>Run cancelled:</strong> {run.cancellationReason}</p>}
        {!run && <p className="notice">{view === "leader" ? "You’re not leading any run weeks yet." : "No run weeks are available yet."}</p>}
        {view === "runs" && run && <BookingGroups snapshot={snapshot} run={run} groups={groups} mutate={mutate} pending={pending} now={now} />}
        {view === "detail" && run && (() => {
          const group = snapshot.groups.find(g => g.id === groupId);
          return group ? <><GroupDetail snapshot={snapshot} run={run} group={group} /><BookingGroups snapshot={snapshot} run={run} groups={[group]} mutate={mutate} pending={pending} now={now} /></> : <p className="notice">Group not found.</p>;
        })()}
        {view === "leader" && run && <section className="stack">
          {groups.filter(g => g.leaderId === snapshot.currentMemberId).map(g => <LeaderGroup key={`${g.id}:${g.version}`} snapshot={snapshot} run={run} group={g} mutate={mutate} pending={pending} now={now} />)}
          {!groups.some(g => g.leaderId === snapshot.currentMemberId) && <p className="notice">You have no assigned groups for this week.</p>}
        </section>}
        {view === "admin" && <Admin snapshot={snapshot} run={run} groups={groups} mutate={mutate} pending={pending} now={now} selectWeek={setSelectedId} />}
      </>}
    {view === "runs" && historicalWeeks.length > 0 && <details className="week-history"><summary>Past runs · {historicalWeeks.length}</summary>
      <label htmlFor="history-week">Past run week<select id="history-week" value={historicalWeeks.some(week => week.id === effectiveSelectedId) ? effectiveSelectedId : ""} onChange={event => { if (event.target.value) setSelectedId(event.target.value); }}>
        <option value="">Choose a past run</option>{historicalWeeks.map(week => <option key={week.id} value={week.id}>{dateLabel(week.startsAt, snapshot.config.timeZone)} · {runnerStatus(week, now)}</option>)}
      </select></label>
      {activeWeeks.length > 0 && <button className="secondary" onClick={() => setSelectedId(activeWeeks.find(week => bookingIsOpen(week, new Date(now)))?.id ?? activeWeeks[0].id)}>Back to upcoming run</button>}
    </details>}
    <footer className="site-footer"><strong>Better together.</strong><span>PETTS WOOD RUNNERS Tuesday Club Runs</span></footer>
  </main>;
}

function GroupDetail({ snapshot, run, group }: { snapshot: PlatformSnapshot; run: Run; group: Group }) {
  const confirmed = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "confirmed");
  const queue = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted").sort((a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id));
  return <section className="panel">
    <Link href="/">← All pace groups</Link><h2>Group {group.number} · {group.name}</h2>
    <p>{group.paceLabel} · {group.distanceLabel ?? "Distance to be confirmed"}</p>
    <p><strong>Leader:</strong> {memberName(snapshot, group.leaderId)} · <strong>Sweeper:</strong> {memberName(snapshot, group.sweeperId)}</p>
    <h3>Route</h3><p className="route">{group.routeDescription ? <RouteDescription text={group.routeDescription} /> : "Route not yet provided."}</p>
    <h3>Confirmed runners · {confirmed.length}/{group.capacity}</h3>
    <ul className="roster">{confirmed.map(b => <li key={b.id}>{memberName(snapshot, b.memberId)}{b.memberId === snapshot.currentMemberId && " (you)"}{b.source === "assignment" && " · assigned volunteer"}</li>)}</ul>
    <h3>Waitlist · {queue.length}</h3>
    <p>When a place opens while bookings are open, the first eligible queued runner is promoted automatically. No promotions happen at or after the cutoff. A queue place is not a confirmed booking.</p>
    <ol className="roster queue">{queue.map((b, i) => <li key={b.id}>#{i + 1} · {memberName(snapshot, b.memberId)}{b.memberId === snapshot.currentMemberId && " (you)"}</li>)}</ol>
    {!queue.length && <p>No one waiting.</p>}
    <p className="hint">{dateLabel(run.startsAt)} · Attendance is recorded by your assigned leader, not inferred from booking.</p>
  </section>;
}

function LeaderGroup({ snapshot, run, group, mutate, pending, now }: { snapshot: PlatformSnapshot; run: Run; group: Group; mutate: Mutate; pending: boolean; now: number }) {
  const payload = { runId: run.id, groupId: group.id, runVersion: run.version, groupVersion: group.version };
  const confirmed = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "confirmed");
  return <article className="panel">
    <div className="section-title"><h2>Group {group.number} · {group.paceLabel}</h2><span className="badge">{confirmed.length} confirmed</span></div>
    <p>Leader: {memberName(snapshot, group.leaderId)} · {group.distanceLabel ?? "Distance to be confirmed"}</p>
    {group.cancelled ? <p className="notice">This group is not running ({group.cancellationReason === "no-leader" ? "no leader available" : "insufficient interest"}).</p> : ["draft", "published"].includes(run.status) && Date.parse(run.startsAt) > now && <button type="button" className="secondary group-cancel-action" disabled={pending} onClick={() => {
      if (window.confirm(`Cancel Group ${group.number} for insufficient interest? Existing bookings will be cancelled.`)) {
        void mutate("cancelGroup", { ...payload, reason: "low-interest" });
      }
    }}>Cancel group · low interest</button>}
    <RouteEditor run={run} group={group} mutate={mutate} pending={pending} now={now} />
    <h3 className="subheading">Attendance roster</h3>
    <p className="hint">Unknown means no attendance has been recorded. Record outcomes after the run starts.</p>
    <ul className="roster attendance-roster">{confirmed.map(b => {
      const outcome = snapshot.attendance.find(a => a.runId === run.id && a.memberId === b.memberId)?.outcome;
      return <li key={b.id}><span>{memberName(snapshot, b.memberId)} <span className="badge">{outcome ?? "unknown"}</span></span>
        <div className="actions">{(["present", "absent"] as const).map(o => <button key={o} className="secondary" disabled={pending || run.status !== "published" || Date.parse(run.startsAt) > now} aria-pressed={outcome === o} onClick={() => void mutate("recordAttendance", { ...payload, memberId: b.memberId, outcome: o })}>{o === "present" ? "Present" : "Absent"}</button>)}</div>
      </li>;
    })}</ul>
    <Link href={`/groups/${encodeURIComponent(group.id)}`}>View full group and waitlist →</Link>
  </article>;
}

function RouteEditor({ run, group, mutate, pending, now }: { run: Run; group: Group; mutate: Mutate; pending: boolean; now: number }) {
  const [route, setRoute] = useState(group.routeDescription ?? "");
  return <form onSubmit={e => { e.preventDefault(); void mutate("updateRoute", { runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, routeDescription: route }); }}>
    <label htmlFor={`route-${group.id}`}>Group {group.number} route</label>
    <textarea className="route-input" id={`route-${group.id}`} required minLength={3} maxLength={4000} value={route} onChange={e => setRoute(e.target.value)} rows={2} />
    <button disabled={pending || ["cancelled", "archived"].includes(run.status) || Date.parse(run.startsAt) <= now}>Save route</button>
  </form>;
}

function Profile({ snapshot }: { snapshot: PlatformSnapshot }) {
  const id = snapshot.currentMemberId!;
  const bookings = snapshot.bookings.filter(b => b.memberId === id).sort((a, b) => (snapshot.weeks.find(r => r.id === b.runId)?.startsAt ?? "").localeCompare(snapshot.weeks.find(r => r.id === a.runId)?.startsAt ?? ""));
  const confirmedBookings = bookings.filter(booking => booking.status === "confirmed" &&
    snapshot.weeks.some(week => week.id === booking.runId && ["published", "archived"].includes(week.status)) &&
    snapshot.groups.some(group => group.id === booking.groupId && !group.cancelled));
  const confirmedRuns = new Set(confirmedBookings.map(booking => booking.runId)).size;
  const groupCounts = new Map<number, Set<string>>();
  for (const booking of confirmedBookings) {
    const number = snapshot.groups.find(group => group.id === booking.groupId)!.number;
    const runs = groupCounts.get(number) ?? new Set<string>();
    runs.add(booking.runId);
    groupCounts.set(number, runs);
  }
  const favourite = [...groupCounts].sort((first, second) => second[1].size - first[1].size || first[0] - second[0])[0]?.[0];
  const leadershipCount = new Set(snapshot.groups.filter(group => group.leaderId === id && !group.cancelled &&
    snapshot.weeks.some(week => week.id === group.runId && ["published", "archived"].includes(week.status))).map(group => group.runId)).size;
  return <section>
    <div className="stats profile-stats"><div className="stat"><span>Runs attended</span><strong>{confirmedRuns}</strong></div><div className="stat"><span>Runs led</span><strong>{leadershipCount}</strong></div><div className="stat"><span>Favourite group</span><strong>{favourite ? `Group ${favourite}` : "Not yet"}</strong></div><div className="stat"><span>Active bookings</span><strong>{bookings.filter(b => b.status !== "cancelled" && snapshot.weeks.some(w => w.id === b.runId && w.status === "published")).length}</strong></div></div>
    <h2>My booking & attendance history</h2><p className="hint">Runs attended and favourite group use confirmed bookings, including upcoming runs, not marked attendance. Favourite ties choose the lowest group number.</p>
    <div className="table-wrap"><table><thead><tr><th>Week</th><th>Group</th><th>Booking</th><th>Attendance</th></tr></thead><tbody>{bookings.map(b => {
      const run = snapshot.weeks.find(r => r.id === b.runId);
      const group = snapshot.groups.find(g => g.id === b.groupId);
      const outcome = snapshot.attendance.find(a => a.runId === b.runId && a.memberId === id)?.outcome;
      return <tr key={b.id}><td>{run ? dateLabel(run.startsAt) : b.runId}</td><td><Link href={`/groups/${encodeURIComponent(b.groupId)}`}>Group {group?.number ?? "—"}</Link></td><td>{b.status}{b.status === "waitlisted" && ` · queue #${queuePosition(snapshot, b.groupId, id)}`}</td><td>{outcome ?? "Unknown / not recorded"}</td></tr>;
    })}</tbody></table></div>
    {!bookings.length && <p className="notice">Your first club run starts here. Choose a pace group to join.</p>}
  </section>;
}

function AutomationSettings({ snapshot, mutate, pending }: { snapshot: PlatformSnapshot; mutate: Mutate; pending: boolean }) {
  const [enabled, setEnabled] = useState(snapshot.config.weeklyAutomationEnabled ?? false);
  const [publishTime, setPublishTime] = useState(snapshot.config.weeklyPublishTime ?? "18:00");
  return <form className="inline-form" onSubmit={event => {
    event.preventDefault();
    void mutate("updateWeeklyAutomation", { configVersion: snapshot.config.version ?? 1, enabled, publishTime });
  }}>
    <label className="check automation-toggle"><input type="checkbox" checked={enabled} disabled={pending} onChange={event => setEnabled(event.target.checked)} /><span>Weekly automation</span></label>
    <label>Sunday publication time<input type="time" required value={publishTime} disabled={pending} onChange={event => setPublishTime(event.target.value)} /></label>
    <button disabled={pending}>Save weekly settings</button>
  </form>;
}

function WeekTimeEditor({ snapshot, run, mutate, pending, now }: { snapshot: PlatformSnapshot; run: Run; mutate: Mutate; pending: boolean; now: number }) {
  const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const [startTime, setStartTime] = useState(timeFormat.format(new Date(run.startsAt)));
  let preview: ReturnType<typeof updateRunTime> | undefined;
  let error = "";
  try { preview = updateRunTime(run, startTime, snapshot.config, new Date(now)); }
  catch (caught) { error = caught instanceof Error ? caught.message : "Invalid start time."; }
  return <form className="inline-form" onSubmit={event => {
    event.preventDefault();
    if (preview) void mutate("updateWeekTime", { runId: run.id, runVersion: run.version, startTime });
  }}>
    <label>Start time for this week<input type="time" required value={startTime} disabled={pending} onChange={event => setStartTime(event.target.value)} /></label>
    <button disabled={pending || !preview}>Save start time</button>
    <p className="hint">{preview ? `Booking cutoff: ${timeFormat.format(new Date(preview.bookingClosesAt))} (${snapshot.config.timeZone}). Published cutoffs never move later.` : error}</p>
  </form>;
}

function Admin({ snapshot, run, groups, mutate, pending, now, selectWeek }: { snapshot: PlatformSnapshot; run?: Run; groups: Group[]; mutate: Mutate; pending: boolean; now: number; selectWeek: (id: string) => void }) {
  const memberPageSize = 25;
  const configuredLocations = snapshot.config.locations?.length ? snapshot.config.locations : DEFAULT_LOCATIONS;
  const locationOptions = [...new Set([...configuredLocations, ...(snapshot.config.location && !/\bDEMO\b/i.test(snapshot.config.location) ? [snapshot.config.location] : [])])]
    .filter(location => location.trim().toLowerCase() !== "willett rec");
  const [date, setDate] = useState("");
  const [copy, setCopy] = useState("");
  const [newWeekLocation, setNewWeekLocation] = useState(snapshot.config.location && locationOptions.includes(snapshot.config.location) ? snapshot.config.location : locationOptions[0] ?? "");
  const [moveMember, setMoveMember] = useState("");
  const [moveGroup, setMoveGroup] = useState("");
  const [search, setSearch] = useState("");
  const [memberPage, setMemberPage] = useState(0);
  const [newLocation, setNewLocation] = useState("");
  const [newLocationMapsUrl, setNewLocationMapsUrl] = useState("");
  const initialVenueSelection = locationOptions.includes(snapshot.config.location) ? snapshot.config.location : locationOptions[0] ?? "";
  const [venueSelection, setVenueSelection] = useState(initialVenueSelection);
  const [venueMapsUrl, setVenueMapsUrl] = useState(snapshot.config.locationMaps?.[initialVenueSelection] ?? "");
  const popularity = bookingPopularity(snapshot, new Date(now));
  const maxAverageConfirmed = Math.max(0, ...popularity.map(group => group.averageConfirmed));
  const totalConfirmed = popularity.reduce((total, group) => total + group.confirmed, 0);
  const totalWaitlisted = popularity.reduce((total, group) => total + group.waitlisted, 0);
  const totalCapacity = popularity.reduce((total, group) => total + group.capacity, 0);
  const queueMetrics = waitlistAnalytics(snapshot);
  const filteredMembers = snapshot.members.filter(m => `${m.name} ${m.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredMembers.length / memberPageSize));
  const currentMemberPage = Math.min(memberPage, pageCount - 1);
  const visibleMembers = filteredMembers.slice(currentMemberPage * memberPageSize, (currentMemberPage + 1) * memberPageSize);
  const runningGroups = groups.filter(group => !group.cancelled);
  const missingLeaders = runningGroups.filter(group => !snapshot.members.some(member => member.id === group.leaderId && member.active && member.roles.includes("leader")));
  const targetDate = nextTuesdayDate(new Date(now), snapshot.config.timeZone);
  const targetRun = snapshot.weeks.find(week => clubDate(new Date(week.startsAt), snapshot.config.timeZone) === targetDate);
  const scheduledRun = targetRun?.status === "draft" ? targetRun : undefined;
  const scheduledBlockers = scheduledRun ? publicationBlockers(snapshot, scheduledRun, new Date(now)) : [];
  let nextPublication = sundayPublicationAt(scheduledRun ?? { startsAt: clubDateTime(targetDate, snapshot.config.startTime, snapshot.config.timeZone) }, snapshot.config);
  if (targetRun && !scheduledRun) {
    const nextStart = new Date(`${targetDate}T12:00:00Z`);
    nextStart.setUTCDate(nextStart.getUTCDate() + 7);
    nextPublication = sundayPublicationAt({ startsAt: clubDateTime(nextStart.toISOString().slice(0, 10), snapshot.config.startTime, snapshot.config.timeZone) }, snapshot.config);
  }
  const localTimestamp = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const lastCheck = snapshot.schedulerHealth?.lastSuccessfulCheckAt;
  const nextRun = [...snapshot.weeks].filter(week => Date.parse(week.startsAt) > now && ["draft", "published"].includes(week.status)).sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
  function create(e: FormEvent) { e.preventDefault(); void mutate("createWeek", { date, location: newWeekLocation, ...(copy ? { copyFromRunId: copy } : {}) }); }
  function addLocation(e: FormEvent) {
    e.preventDefault();
    const value = newLocation.trim();
    if (!value) return;
    const existing = locationOptions.find(location => location.toLowerCase() === value.toLowerCase());
    const locations = existing ? locationOptions : [...locationOptions, value];
    const location = existing ?? value;
    const locationMaps = { ...DEFAULT_LOCATION_MAPS, ...Object.fromEntries(Object.entries(snapshot.config.locationMaps ?? {}).filter(([venue]) => locationOptions.includes(venue))) };
    if (newLocationMapsUrl.trim()) locationMaps[location] = newLocationMapsUrl.trim();
    void mutate("updateLocations", { location, locations, locationMaps });
    setVenueSelection(location);
    setVenueMapsUrl(locationMaps[location] ?? "");
    setNewWeekLocation(location);
    setNewLocation("");
    setNewLocationMapsUrl("");
  }
  function saveVenueMap(e: FormEvent) {
    e.preventDefault();
    const locationMaps = { ...DEFAULT_LOCATION_MAPS, ...Object.fromEntries(Object.entries(snapshot.config.locationMaps ?? {}).filter(([venue]) => locationOptions.includes(venue))) };
    if (venueMapsUrl.trim()) locationMaps[venueSelection] = venueMapsUrl.trim();
    else delete locationMaps[venueSelection];
    void mutate("updateLocations", { location: snapshot.config.location, locations: locationOptions, locationMaps });
  }
  function removeLocation(locationToRemove: string) {
    if (locationOptions.length < 2) return;
    const locations = locationOptions.filter(location => location !== locationToRemove);
    const location = snapshot.config.location === locationToRemove ? locations[0] : snapshot.config.location;
    const locationMaps = Object.fromEntries(Object.entries(snapshot.config.locationMaps ?? {}).filter(([venue]) => locations.includes(venue)));
    void mutate("updateLocations", { location, locations, locationMaps });
    if (venueSelection === locationToRemove) {
      setVenueSelection(location);
      setVenueMapsUrl(locationMaps[location] ?? DEFAULT_LOCATION_MAPS[location] ?? "");
    }
    if (newWeekLocation === locationToRemove) setNewWeekLocation(location);
  }
  return <div className="stack admin-dashboard">
    <section className="panel"><h2>{run ? `${run.id === nextRun?.id ? "Next Tuesday" : "Selected Tuesday"} · ${dateLabel(run.startsAt, snapshot.config.timeZone)}` : "Next Tuesday"}</h2>
      {run && <div className="selected-run-summary">
        <p><strong>{run.location ?? snapshot.config.location}</strong> · {new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(run.startsAt))} · <span className={`badge ${run.status}`}>{run.status}</span></p>
        <p><strong>Leader readiness: {runningGroups.length - missingLeaders.length}/{runningGroups.length}</strong> running groups</p>
        {missingLeaders.length > 0 ? <p className="hint">Missing leaders: {missingLeaders.map(group => `Group ${group.number}`).join(", ")}. <a href="#volunteers">Assign leaders</a></p> : <p className="hint">{runningGroups.length ? "All running groups have an eligible leader." : "No groups are running."}</p>}
      </div>}
      <WeeklyLeaderImport snapshot={snapshot} mutate={mutate} pending={pending} />
      <details className="admin-disclosure" suppressHydrationWarning><summary>Automation and schedule · {snapshot.config.weeklyAutomationEnabled ? "On" : "Off"}</summary><div className="disclosure-content">
      <div className="automation-health" aria-label="Automation health">
      <h3>Scheduler status</h3>
      <dl className="scheduler-status">
        <div><dt>Publication schedule</dt><dd>Sunday {snapshot.config.weeklyPublishTime ?? "18:00"} · {snapshot.config.timeZone}</dd></div>
        <div><dt>Last successful check</dt><dd>{lastCheck ? localTimestamp(lastCheck) : "Not recorded"}{snapshot.demo && " (demo only)"}</dd></div>
        <div><dt>{Date.parse(nextPublication) <= now ? "Publication due" : "Next publication"}</dt><dd>{snapshot.config.weeklyAutomationEnabled ? localTimestamp(nextPublication) : "Automatic publication off"}</dd></div>
      </dl>
      {!snapshot.demo && <p className="hint">{!lastCheck ? "Timer operation is unverified. The workbook owner must install and check the Apps Script trigger." : now - Date.parse(lastCheck) > 45 * 60_000 ? "Scheduler check is overdue. The workbook owner should check the trigger and execution log." : "A successful check is recorded; this does not verify that a timer remains installed."}</p>}
      {!targetRun && snapshot.config.weeklyAutomationEnabled && <p className="hint">Next Tuesday draft is not prepared yet. Check the scheduler before relying on publication.</p>}
      {targetRun?.status === "cancelled" && <p className="hint">Next Tuesday is cancelled. Automation will not recreate or publish that run.</p>}
      {scheduledRun && scheduledBlockers.length > 0 && <p className="notice">{snapshot.config.weeklyAutomationEnabled && Date.parse(nextPublication) <= now ? "Publication blocked" : "Not ready"}: {scheduledBlockers.join("; ")}</p>}
      </div>
      <details className="admin-disclosure" suppressHydrationWarning><summary>Weekly settings</summary><div className="disclosure-content">
      <AutomationSettings key={snapshot.config.version ?? 1} snapshot={snapshot} mutate={mutate} pending={pending} />
      <p className="hint">Tuesday drafts use club defaults. Sunday publication requires an eligible leader for every running group; routes and attendance are optional. Completed published weeks archive the following Sunday, retaining unknown attendance. No reminders are sent.</p>
      <p className="hint">{snapshot.demo ? "Demo automation is process-local; no live timer or workbook is used." : "The workbook owner must install the Apps Script timer before unattended scheduling can run."}</p>
      </div></details>
      </div></details>
      {snapshot.weeks.some(week => week.status === "draft" && Date.parse(week.startsAt) > now) && <><h3>Upcoming drafts</h3>
      <ul className="roster">{snapshot.weeks.filter(week => week.status === "draft" && Date.parse(week.startsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(week => {
        const blockers = publicationBlockers(snapshot, week, new Date(now));
        const due = Date.parse(sundayPublicationAt(week, snapshot.config)) <= now;
        return <li key={week.id}><button type="button" className="secondary" aria-pressed={week.id === run?.id} onClick={() => selectWeek(week.id)}>{dateLabel(week.startsAt, snapshot.config.timeZone)}</button><span>{blockers.length ? `${due && snapshot.config.weeklyAutomationEnabled ? "Publication blocked" : "Not ready"}: ${blockers.join("; ")}` : snapshot.config.weeklyAutomationEnabled ? "Ready for scheduled publication" : "Ready; automation off"}</span></li>;
      })}</ul></>}
      <details className="admin-disclosure advanced-controls" suppressHydrationWarning><summary>Advanced controls</summary><div className="disclosure-content">
      <details className="admin-disclosure" suppressHydrationWarning><summary>Create an additional draft manual run</summary><div className="disclosure-content"><form className="inline-form" onSubmit={create}>
      <label>New Tuesday<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Location for new week<select required value={newWeekLocation} disabled={!locationOptions.length} onChange={e => setNewWeekLocation(e.target.value)}>{!locationOptions.length && <option value="">Add a venue below first</option>}{locationOptions.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
      <label>Copy scaffold<select value={copy} onChange={e => setCopy(e.target.value)}><option value="">Configured group defaults</option>{snapshot.weeks.map(w => <option key={w.id} value={w.id}>{dateLabel(w.startsAt)}</option>)}</select></label>
      <button disabled={pending || !locationOptions.length}>Create draft week</button>
    </form>{!locationOptions.length ? <p className="notice">No venues are available. Add a location in the Venue list below before creating a week.</p> : <p className="hint">No runners or volunteer assignments are copied.</p>}</div></details>
      {run && <><h3 className="subheading">Selected run overrides</h3><div className="actions">
        <button disabled={pending || run.status !== "draft"} onClick={() => void mutate("publishRun", { runId: run.id, runVersion: run.version })}>Publish selected week</button>
        <button className="secondary" disabled={pending || run.status !== "published" || Date.parse(run.startsAt) > now} onClick={() => void mutate("archiveRun", { runId: run.id, runVersion: run.version })}>Archive completed week</button>
      </div></>}
      </div></details>
    {run && ["draft", "published"].includes(run.status) && Date.parse(run.startsAt) > now && <div className="week-location-panel">
      <details className="admin-disclosure" suppressHydrationWarning>
        <summary>Location and time for this week</summary>
        <div className="disclosure-content">
          <p className="hint">Changes only the venue for {dateLabel(run.startsAt, snapshot.config.timeZone)}.</p>
          <label>Location for this week<select value={run.location && locationOptions.includes(run.location) ? run.location : locationOptions.includes(snapshot.config.location) ? snapshot.config.location : ""} disabled={pending || !locationOptions.length} onChange={event => void mutate("updateWeekLocation", { runId: run.id, runVersion: run.version, location: event.target.value })}>{!locationOptions.length && <option value="">Add a venue below first</option>}{locationOptions.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
          {!locationOptions.length && <p className="hint">Add a venue in the Venue list below to set this week’s location.</p>}
          <WeekTimeEditor key={`${run.id}:${run.version}`} snapshot={snapshot} run={run} mutate={mutate} pending={pending} now={now} />
        </div>
      </details>
      <CancelRun runId={run.id} runVersion={run.version} mutate={mutate} pending={pending} />
    </div>}
    </section>
    {run && <section className="panel" id="volunteers"><h2>Volunteers</h2><p className="hint">Assigned leaders occupy a confirmed place in their group.</p>
      <div className="assignment-grid">{groups.map(g => <div className="admin-group-assignment" key={g.id}>
        <SearchableSelect
          label={`Group ${g.number} · ${confirmedCount(g.id, snapshot.bookings)}/${g.capacity} · Leader`}
          value={g.leaderId ?? ""} placeholder="None"
          options={[{ value: "", label: "None" }, ...snapshot.members.filter(m => m.active && m.roles.includes("leader")).map(m => ({
            value: m.id,
            label: m.name,
            disabled: !canAssignLeaderToGroup(m.id, g, groups, snapshot.bookings),
          }))]}
          disabled={pending || !["draft", "published"].includes(run.status) || Date.parse(run.startsAt) <= now || g.cancelled === true}
          onChange={memberId => void mutate("assignLeader", { runId: run.id, runVersion: run.version, groupId: g.id, groupVersion: g.version, memberId })}
        />
        {g.cancelled ? <span className="hint">Not running · {g.cancellationReason === "no-leader" ? "no leader available" : "insufficient interest"}</span> : ["draft", "published"].includes(run.status) && Date.parse(run.startsAt) > now && <div className="admin-group-actions">
          {!g.leaderId && <button type="button" className="secondary no-leader-action" disabled={pending} onClick={() => {
            if (window.confirm(`Mark Group ${g.number} as not held because no leader is available? Existing bookings will be cancelled.`)) {
              void mutate("cancelGroup", { runId: run.id, runVersion: run.version, groupId: g.id, groupVersion: g.version, reason: "no-leader" });
            }
          }}>Cancel · no leader</button>}
          <button type="button" className="secondary no-leader-action" disabled={pending} onClick={() => {
            if (window.confirm(`Cancel Group ${g.number} for insufficient interest? Existing bookings will be cancelled.`)) {
              void mutate("cancelGroup", { runId: run.id, runVersion: run.version, groupId: g.id, groupVersion: g.version, reason: "low-interest" });
            }
          }}>Cancel · low interest</button>
        </div>}
      </div>)}</div>
    </section>}
    {run && <section className="panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Runner moves</summary>
      <div className="disclosure-content"><p className="hint">Move a runner between groups. A full destination puts them on its waitlist.</p><form className="inline-form" onSubmit={e => {
        e.preventDefault(); const destination = groups.find(g => g.id === moveGroup);
        if (destination) void mutate("moveRunner", { runId: run.id, runVersion: run.version, groupId: destination.id, groupVersion: destination.version, memberId: moveMember });
      }}>
        <SearchableSelect label="Runner" value={moveMember} placeholder="Select runner"
          options={snapshot.bookings.filter(b => b.runId === run.id && b.status !== "cancelled" && b.source !== "assignment")
            .map(b => ({ value: b.memberId, label: memberName(snapshot, b.memberId) }))}
          onChange={setMoveMember} />
        <SearchableSelect label="Destination" value={moveGroup} placeholder="Select group"
          options={groups.map(g => ({ value: g.id, label: `Group ${g.number} · ${g.paceLabel}` }))}
          onChange={setMoveGroup} />
        <button disabled={pending || !bookingIsOpen(run, new Date(now))}>Move runner</button>
      </form></div>
    </details></section>}
    <section className="panel attendance-panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Group popularity</summary>
      <div className="disclosure-content"><p>All available completed published/archived weeks, excluding cancelled groups. Zero-booking weeks count in averages; future and draft weeks do not.</p>
      <p className="hint">Confirmed bookings include assigned volunteers and measure booking demand, not actual attendance. Waitlist averages use the final retained queue, not everyone who ever joined it.</p>
      <div className="stats"><div className="stat"><span>Confirmed bookings</span><strong>{totalConfirmed}</strong></div><div className="stat"><span>Retained waitlisted bookings</span><strong>{totalWaitlisted}</strong></div><div className="stat"><span>Booking fill</span><strong>{totalCapacity ? `${Math.round(totalConfirmed / totalCapacity * 100)}%` : "Not available"}</strong></div></div>
      {!popularity.length && <p className="notice">No completed running groups are available yet.</p>}
      <h3 className="subheading">Average confirmed bookings by group</h3>
      <div className="average-attendance-chart" aria-label="Average confirmed bookings by group">
        {popularity.map(group => <div className="average-attendance-row" key={group.number}>
          <span>Group {group.number}</span>
          <div className="average-attendance-track"><span style={{ width: `${maxAverageConfirmed ? group.averageConfirmed / maxAverageConfirmed * 100 : 0}%` }} /></div>
          <strong>{group.averageConfirmed.toFixed(1)}</strong>
        </div>)}
      </div>
      <div className="table-wrap"><table><caption>Group popularity: completed-week booking demand</caption><thead><tr><th>Group</th><th>Avg. confirmed bookings</th><th>Avg. retained waitlist</th><th>Booking fill</th><th>Completed weeks</th><th>Different leaders</th><th>Confirmed bookings</th></tr></thead><tbody>{popularity.map(group => <tr key={group.number}><td>Group {group.number}</td><td>{group.averageConfirmed.toFixed(1)}</td><td>{group.averageWaitlisted.toFixed(1)}</td><td>{group.bookingUtilisation === undefined ? "Not available" : `${group.bookingUtilisation}%`}</td><td>{group.completedWeeks}</td><td>{group.leaderCount}</td><td>{group.confirmed}</td></tr>)}</tbody></table></div>
      <p className="hint">Booking fill = total confirmed bookings / total available capacity across completed weeks. Each average divides by the number of completed weeks that group ran.</p>
      {run && run.status !== "cancelled" && <div className="table-wrap"><table><caption>Selected week: group demand</caption><thead><tr><th>Group</th><th>Confirmed / capacity</th><th>Booking fill</th><th>Current waitlist</th></tr></thead><tbody>{groups.filter(group => !group.cancelled).map(group => {
        const confirmed = snapshot.bookings.filter(booking => booking.groupId === group.id && booking.status === "confirmed").length;
        const waitlisted = snapshot.bookings.filter(booking => booking.groupId === group.id && booking.status === "waitlisted").length;
        return <tr key={group.id}><td>Group {group.number} · {group.paceLabel}</td><td>{confirmed} / {group.capacity}</td><td>{group.capacity ? `${Math.round(confirmed / group.capacity * 100)}%` : "Not available"}</td><td>{waitlisted}</td></tr>;
      })}</tbody></table></div>}
      <h3 className="subheading">Recorded waitlist flow</h3>
      <div className="stats"><div className="stat"><span>Waitlist joins</span><strong>{queueMetrics.joins}</strong></div><div className="stat"><span>Promotions / joins</span><strong>{queueMetrics.promotions} / {queueMetrics.joins}</strong><span>{queueMetrics.promotionRate === undefined ? "No recorded joins" : `${queueMetrics.promotionRate}% promoted`}</span></div><div className="stat"><span>Peak recorded group queue</span><strong>{queueMetrics.peakQueue ?? "Unknown"}</strong><span>{queueMetrics.withdrawals} recorded withdrawals</span></div></div>
      <p className="hint">Recorded published/archived-week events only; draft and cancelled weeks are excluded. Promotion rate = promotions ÷ waitlist joins (not confirmed bookings). Peak is the maximum recorded individual-group queue, not an aggregate of all queues or today’s queue; unavailable history is never inferred.</p>
      </div>
    </details></section>
    <section className="panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Club members</summary>
      <div className="disclosure-content"><MemberOnboarding snapshot={snapshot} mutate={mutate} pending={pending} /><label>Search members<input type="search" value={search} onChange={e => { setSearch(e.target.value); setMemberPage(0); }} placeholder="Name or email" /></label>
        <p className="hint" role="status">{filteredMembers.length ? `Showing ${currentMemberPage * memberPageSize + 1}–${Math.min((currentMemberPage + 1) * memberPageSize, filteredMembers.length)} of ${filteredMembers.length} members` : "No members match this search."}</p>
        <div className="member-list">{visibleMembers.map(m => <MemberEditor key={`${m.id}:${m.version}`} member={m} mutate={mutate} pending={pending} />)}</div>
        {filteredMembers.length > memberPageSize && <nav className="member-pagination" aria-label="Member pages">
          <button type="button" className="secondary" disabled={currentMemberPage === 0} onClick={() => setMemberPage(currentMemberPage - 1)}>Previous</button>
          <span>Page {currentMemberPage + 1} of {pageCount}</span>
          <button type="button" className="secondary" disabled={currentMemberPage >= pageCount - 1} onClick={() => setMemberPage(currentMemberPage + 1)}>Next</button>
        </nav>}
      </div>
    </details>
    </section>
    <section className="panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Audit trail</summary>
      <div className="disclosure-content"><p>Accountable actions, newest first.</p><ul className="audit">{snapshot.audit.slice(0, 100).map(a => <li key={a.id}><strong>{a.action}</strong> · {memberName(snapshot, a.actorId)} · {new Date(a.at).toLocaleString("en-GB", { timeZone: snapshot.config.timeZone })}<br /><small>Request {a.requestId}</small></li>)}</ul>{!snapshot.audit.length && <p>No recorded changes yet.</p>}</div>
    </details></section>
    <section className="panel location-settings"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Venue list</summary>
      <div className="disclosure-content"><p className="hint">Choose the default venue for new weeks and maintain a Maps link for each saved location.</p>
      <form className="venue-editor" onSubmit={saveVenueMap}>
        <label htmlFor="club-location">Default location<select id="club-location" value={locationOptions.includes(snapshot.config.location) ? snapshot.config.location : ""} disabled={pending || !locationOptions.length} onChange={event => void mutate("updateLocations", { location: event.target.value, locations: locationOptions, locationMaps: Object.fromEntries(Object.entries(snapshot.config.locationMaps ?? {}).filter(([venue]) => locationOptions.includes(venue))) })}>
          {!locationOptions.includes(snapshot.config.location) && <option value="">Choose a saved location</option>}
          {locationOptions.map(location => <option key={location} value={location}>{location}</option>)}
        </select></label>
        <label htmlFor="venue-map-select">Edit Maps link for<select id="venue-map-select" value={venueSelection} disabled={pending || !locationOptions.length} onChange={event => { setVenueSelection(event.target.value); setVenueMapsUrl(snapshot.config.locationMaps?.[event.target.value] ?? ""); }}>{locationOptions.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
        <label htmlFor="venue-map-url">Google Maps link<input id="venue-map-url" type="url" value={venueMapsUrl} onChange={event => setVenueMapsUrl(event.target.value)} placeholder="https://www.google.com/maps/..." /></label>
        <button className="secondary" disabled={pending || !locationOptions.length}>Save Maps link</button>
      </form>
      <form className="venue-add-form" onSubmit={addLocation}>
        <label htmlFor="new-location">Add location<input id="new-location" value={newLocation} maxLength={120} onChange={event => setNewLocation(event.target.value)} placeholder="Venue name or address" /></label>
        <label htmlFor="new-location-map">Google Maps link<input id="new-location-map" type="url" value={newLocationMapsUrl} onChange={event => setNewLocationMapsUrl(event.target.value)} placeholder="https://www.google.com/maps/..." /></label>
        <button disabled={pending || !newLocation.trim()}>Add location</button>
      </form>
      <ul className="venue-list" aria-label="Saved venues">{locationOptions.map(location => <li key={location}>
        <span>{location}</span><button type="button" className="secondary" disabled={pending || locationOptions.length < 2} onClick={() => removeLocation(location)}>Remove</button>
      </li>)}</ul>
      </div>
    </details>
    </section>
  </div>;
}

function MemberEditor({ member, mutate, pending }: { member: ClubMember; mutate: Mutate; pending: boolean }) {
  const [name, setName] = useState(member.name);
  const [roles, setRoles] = useState(member.roles);
  const [active, setActive] = useState(member.active);
  return <form className="member-editor" onSubmit={e => { e.preventDefault(); void mutate("updateMember", { memberId: member.id, memberVersion: member.version, name, roles, active }); }}>
    <label><span className="sr-only">Name for {member.name}</span><input required value={name} onChange={e => setName(e.target.value)} /><small>{member.email || "Email restricted"}</small></label>
    <fieldset><legend className="sr-only">Roles for {member.name}</legend>{["runner", "leader", "sweeper", "admin"].map(role => <label className="check" key={role}><input type="checkbox" checked={roles.includes(role)} onChange={e => setRoles(e.target.checked ? [...roles, role] : roles.filter(r => r !== role))} />{role}</label>)}<label className="check"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Active</label></fieldset>
    <button disabled={pending} className="secondary">Save member</button>
  </form>;
}
