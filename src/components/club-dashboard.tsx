"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Group, Run } from "@/lib/domain";
import { bookingIsOpen, confirmedCount } from "@/lib/domain";
import type { ClubMember, PlatformSnapshot } from "@/lib/platform-types";
import { favouriteGroup, groupAnalytics, queuePosition, waitlistAnalytics, weeksLedBy, weeklyAnalytics } from "@/lib/analytics";
import { BookingGroups } from "./booking-groups";
import { CancelRun } from "./cancel-run";
import { SignIn, SignOut } from "./auth-controls";
import { ClubBrand } from "./club-brand";
import { DEFAULT_LOCATIONS, DEFAULT_LOCATION_MAPS } from "@/lib/locations";
import { RouteDescription } from "./route-description";
import { SearchableSelect } from "./searchable-select";
import { canAssignLeaderToGroup } from "@/lib/leader-availability";

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

export function ClubDashboard({ initial, view = "runs", groupId }: {
  initial: PlatformSnapshot; view?: "runs" | "leader" | "admin" | "profile" | "detail"; groupId?: string;
}) {
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
    [...(view === "leader" ? weeksLedBy(initial, initial.currentMemberId) : initial.weeks)].filter(r => r.status === "published" && new Date(r.startsAt) > new Date()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]?.id ??
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
    <header className="hero">
      <p className="eyebrow">{view === "runs" ? "A little pace. A lot of community." : view === "profile" ? current?.name ?? "Member profile" : `${view} workspace`}</p>
      <h1>{headings[view]}</h1>
      <p className="intro">Tuesday evenings. Shared miles. A group for every pace.</p>
      <div className="meeting"><span className="meeting-pin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.8"/></svg></span><span><a className="meeting-place" href={mapsUrl(meetingLocation, run?.mapsUrl ?? snapshot.config.locationMaps?.[meetingLocation])} target="_blank" rel="noreferrer">{meetingLocation || "Meeting point to be confirmed"} <span className="meeting-map-hint">Open in Google Maps</span></a><br /><strong>{snapshot.config.startTime} · {snapshot.config.timeZone}</strong></span></div>
    </header>
    {message && <p className={failure ? "notice error" : "notice"} role={failure ? "alert" : "status"}>{message}</p>}
    {retry && <p><button disabled={pending} className="secondary" onClick={() => void mutate(retry.operation, retry.payload)}>Retry last save safely</button></p>}
    {(view !== "runs" && !snapshot.currentMemberId) ? <section className="panel"><h2>Members only</h2><p>Sign in to see your club workspace.</p><Link className="button" href="/auth/signin">Sign in</Link></section> :
      view === "admin" && !admin ? <p className="notice">Administrator access is required.</p> :
      view === "leader" && !leader && !admin ? <p className="notice">Leader access is required.</p> :
      view === "profile" ? <Profile snapshot={snapshot} /> : <>
        <section className="week-bar" aria-label="Selected week">
          <label htmlFor="week">Run week<select id="week" disabled={view === "detail" || (view === "leader" && !leaderWeeks.length)} value={effectiveSelectedId} onChange={e => setSelectedId(e.target.value)}>
            {availableWeeks.map(w => <option key={w.id} value={w.id}>{dateLabel(w.startsAt, snapshot.config.timeZone)} · {w.status}</option>)}
          </select></label>
          {run && <div><span className={`badge ${run.status}`}>{run.status}</span><p>{run.status === "published" ? `Booking closes ${dateLabel(run.bookingClosesAt)} at ${new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.config.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(run.bookingClosesAt))}` : "Historical and draft weeks are not open for bookings."}</p></div>}
        </section>
        {run?.cancellationReason && <p className="notice error"><strong>Run cancelled:</strong> {run.cancellationReason}</p>}
        {!run && <p className="notice">{view === "leader" ? "You’re not leading any run weeks yet." : "No run weeks are available yet."}</p>}
        {view === "runs" && run && <BookingGroups snapshot={snapshot} run={run} groups={groups} mutate={mutate} pending={pending} />}
        {view === "detail" && run && (() => {
          const group = snapshot.groups.find(g => g.id === groupId);
          return group ? <><GroupDetail snapshot={snapshot} run={run} group={group} /><BookingGroups snapshot={snapshot} run={run} groups={[group]} mutate={mutate} pending={pending} /></> : <p className="notice">Group not found.</p>;
        })()}
        {view === "leader" && run && <section className="stack">
          {groups.filter(g => g.leaderId === snapshot.currentMemberId).map(g => <LeaderGroup key={`${g.id}:${g.version}`} snapshot={snapshot} run={run} group={g} mutate={mutate} pending={pending} />)}
          {!groups.some(g => g.leaderId === snapshot.currentMemberId) && <p className="notice">You have no assigned groups for this week.</p>}
        </section>}
        {view === "admin" && <Admin snapshot={snapshot} run={run} groups={groups} mutate={mutate} pending={pending} />}
      </>}
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

function LeaderGroup({ snapshot, run, group, mutate, pending }: { snapshot: PlatformSnapshot; run: Run; group: Group; mutate: Mutate; pending: boolean }) {
  const payload = { runId: run.id, groupId: group.id, runVersion: run.version, groupVersion: group.version };
  const confirmed = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "confirmed");
  return <article className="panel">
    <div className="section-title"><h2>Group {group.number} · {group.paceLabel}</h2><span className="badge">{confirmed.length} confirmed</span></div>
    <p>Leader: {memberName(snapshot, group.leaderId)} · {group.distanceLabel ?? "Distance to be confirmed"}</p>
    {group.cancelled ? <p className="notice">This group is not running ({group.cancellationReason === "no-leader" ? "no leader available" : "insufficient interest"}).</p> : ["draft", "published"].includes(run.status) && new Date(run.startsAt) > new Date() && <button type="button" className="secondary group-cancel-action" disabled={pending} onClick={() => {
      if (window.confirm(`Cancel Group ${group.number} for insufficient interest? Existing bookings will be cancelled.`)) {
        void mutate("cancelGroup", { ...payload, reason: "low-interest" });
      }
    }}>Cancel group · low interest</button>}
    <RouteEditor run={run} group={group} mutate={mutate} pending={pending} />
    <h3 className="subheading">Attendance roster</h3>
    <p className="hint">Unknown means no attendance has been recorded. Record outcomes after the run starts.</p>
    <ul className="roster attendance-roster">{confirmed.map(b => {
      const outcome = snapshot.attendance.find(a => a.runId === run.id && a.memberId === b.memberId)?.outcome;
      return <li key={b.id}><span>{memberName(snapshot, b.memberId)} <span className="badge">{outcome ?? "unknown"}</span></span>
        <div className="actions">{(["present", "absent"] as const).map(o => <button key={o} className="secondary" disabled={pending || run.status !== "published" || new Date(run.startsAt) > new Date()} aria-pressed={outcome === o} onClick={() => void mutate("recordAttendance", { ...payload, memberId: b.memberId, outcome: o })}>{o === "present" ? "Present" : "Absent"}</button>)}</div>
      </li>;
    })}</ul>
    <Link href={`/groups/${encodeURIComponent(group.id)}`}>View full group and waitlist →</Link>
  </article>;
}

function RouteEditor({ run, group, mutate, pending }: { run: Run; group: Group; mutate: Mutate; pending: boolean }) {
  const [route, setRoute] = useState(group.routeDescription ?? "");
  return <form onSubmit={e => { e.preventDefault(); void mutate("updateRoute", { runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version, routeDescription: route }); }}>
    <label htmlFor={`route-${group.id}`}>Group {group.number} route</label>
    <textarea className="route-input" id={`route-${group.id}`} required minLength={3} maxLength={4000} value={route} onChange={e => setRoute(e.target.value)} rows={2} />
    <button disabled={pending || ["cancelled", "archived"].includes(run.status) || new Date(run.startsAt) <= new Date()}>Save route</button>
  </form>;
}

function Profile({ snapshot }: { snapshot: PlatformSnapshot }) {
  const id = snapshot.currentMemberId!;
  const bookings = snapshot.bookings.filter(b => b.memberId === id).sort((a, b) => (snapshot.weeks.find(r => r.id === b.runId)?.startsAt ?? "").localeCompare(snapshot.weeks.find(r => r.id === a.runId)?.startsAt ?? ""));
  const present = snapshot.attendance.filter(a => a.memberId === id && a.outcome === "present").length;
  const favourite = favouriteGroup(snapshot, id);
  return <section>
    <div className="stats"><div className="stat"><span>Actual runs attended</span><strong>{present}</strong></div><div className="stat"><span>Favourite by actual attendance</span><strong>{favourite ? `Group ${favourite}` : "Not yet"}</strong></div><div className="stat"><span>Active bookings</span><strong>{bookings.filter(b => b.status !== "cancelled" && snapshot.weeks.some(w => w.id === b.runId && w.status === "published")).length}</strong></div></div>
    <h2>My booking & attendance history</h2><p className="hint">Favourite uses recorded present outcomes only; ties choose the lowest group number.</p>
    <div className="table-wrap"><table><thead><tr><th>Week</th><th>Group</th><th>Booking</th><th>Attendance</th></tr></thead><tbody>{bookings.map(b => {
      const run = snapshot.weeks.find(r => r.id === b.runId);
      const group = snapshot.groups.find(g => g.id === b.groupId);
      const outcome = snapshot.attendance.find(a => a.runId === b.runId && a.memberId === id)?.outcome;
      return <tr key={b.id}><td>{run ? dateLabel(run.startsAt) : b.runId}</td><td><Link href={`/groups/${encodeURIComponent(b.groupId)}`}>Group {group?.number ?? "—"}</Link></td><td>{b.status}{b.status === "waitlisted" && ` · queue #${queuePosition(snapshot, b.groupId, id)}`}</td><td>{outcome ?? "Unknown / not recorded"}</td></tr>;
    })}</tbody></table></div>
    {!bookings.length && <p className="notice">Your first club run starts here. Choose a pace group to join.</p>}
  </section>;
}

function Admin({ snapshot, run, groups, mutate, pending }: { snapshot: PlatformSnapshot; run?: Run; groups: Group[]; mutate: Mutate; pending: boolean }) {
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
  const totals = weeklyAnalytics(snapshot);
  const popularity = groupAnalytics(snapshot);
  const maxAveragePresent = Math.max(0, ...popularity.map(group => group.averagePresent ?? 0));
  const queueMetrics = waitlistAnalytics(snapshot);
  const history = totals.filter(w => new Date(w.run.startsAt) <= new Date()).slice(-12);
  const totalPresent = history.reduce((n, w) => n + w.present, 0);
  const totalAbsent = history.reduce((n, w) => n + w.absent, 0);
  const totalUnknown = history.reduce((n, w) => n + w.unknown, 0);
  const filteredMembers = snapshot.members.filter(m => `${m.name} ${m.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredMembers.length / memberPageSize));
  const currentMemberPage = Math.min(memberPage, pageCount - 1);
  const visibleMembers = filteredMembers.slice(currentMemberPage * memberPageSize, (currentMemberPage + 1) * memberPageSize);
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
    <section className="panel"><h2>Week lifecycle</h2><form className="inline-form" onSubmit={create}>
      <label>New Tuesday<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Location for new week<select required value={newWeekLocation} disabled={!locationOptions.length} onChange={e => setNewWeekLocation(e.target.value)}>{!locationOptions.length && <option value="">Add a venue below first</option>}{locationOptions.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
      <label>Copy scaffold<select value={copy} onChange={e => setCopy(e.target.value)}><option value="">Configured group defaults</option>{snapshot.weeks.map(w => <option key={w.id} value={w.id}>{dateLabel(w.startsAt)}</option>)}</select></label>
      <button disabled={pending || !locationOptions.length}>Create draft week</button>
    </form>{!locationOptions.length ? <p className="notice">No venues are available. Add a location in the Venue list below before creating a week.</p> : <p className="hint">No runners or volunteer assignments are copied.</p>}
      {run && <><div className="actions">
        <button disabled={pending || run.status !== "draft"} onClick={() => void mutate("publishRun", { runId: run.id, runVersion: run.version })}>Publish selected week</button>
        <button className="secondary" disabled={pending || run.status !== "published" || new Date(run.startsAt) > new Date()} onClick={() => void mutate("archiveRun", { runId: run.id, runVersion: run.version })}>Archive completed week</button>
      </div>{["published", "draft"].includes(run.status) && new Date(run.startsAt) > new Date() && <CancelRun runId={run.id} runVersion={run.version} mutate={mutate} pending={pending} />}</>}
      <p className="hint">Cancelled weeks remain cancelled permanently so the cancellation reason and history are preserved.</p>
    </section>
    {run && ["draft", "published"].includes(run.status) && new Date(run.startsAt) > new Date() && <section className="panel week-location-panel">
      <details className="admin-disclosure" suppressHydrationWarning>
        <summary>Change location for this week</summary>
        <div className="disclosure-content">
          <p className="hint">Changes only the venue for {dateLabel(run.startsAt, snapshot.config.timeZone)}.</p>
          <label>Location for this week<select value={run.location && locationOptions.includes(run.location) ? run.location : locationOptions.includes(snapshot.config.location) ? snapshot.config.location : ""} disabled={pending || !locationOptions.length} onChange={event => void mutate("updateWeekLocation", { runId: run.id, runVersion: run.version, location: event.target.value })}>{!locationOptions.length && <option value="">Add a venue below first</option>}{locationOptions.map(location => <option key={location} value={location}>{location}</option>)}</select></label>
          {!locationOptions.length && <p className="hint">Add a venue in the Venue list below to set this week’s location.</p>}
        </div>
      </details>
    </section>}
    {run && <section className="panel"><h2>Volunteers</h2><p className="hint">Assigned leaders occupy a confirmed place in their group.</p>
      <div className="assignment-grid">{groups.map(g => <div className="admin-group-assignment" key={g.id}>
        <SearchableSelect
          label={`Group ${g.number} · ${confirmedCount(g.id, snapshot.bookings)}/${g.capacity} · Leader`}
          value={g.leaderId ?? ""} placeholder="None"
          options={[{ value: "", label: "None" }, ...snapshot.members.filter(m => m.active && m.roles.includes("leader")).map(m => ({
            value: m.id,
            label: m.name,
            disabled: !canAssignLeaderToGroup(m.id, g, groups, snapshot.bookings),
          }))]}
          disabled={pending || !["draft", "published"].includes(run.status) || new Date(run.startsAt) <= new Date() || g.cancelled === true}
          onChange={memberId => void mutate("assignLeader", { runId: run.id, runVersion: run.version, groupId: g.id, groupVersion: g.version, memberId })}
        />
        {g.cancelled ? <span className="hint">Not running · {g.cancellationReason === "no-leader" ? "no leader available" : "insufficient interest"}</span> : ["draft", "published"].includes(run.status) && new Date(run.startsAt) > new Date() && <div className="admin-group-actions">
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
        <button disabled={pending || !bookingIsOpen(run, new Date())}>Move runner</button>
      </form></div>
    </details></section>}
    <section className="panel attendance-panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Attendance, not assumptions</summary>
      <div className="disclosure-content"><p>Last 12 historical weeks. Attendance rates exclude unknown outcomes; bookings are never counted as attendance.</p>
      <div className="stats"><div className="stat"><span>Recorded present</span><strong>{totalPresent}</strong></div><div className="stat"><span>Recorded absent</span><strong>{totalAbsent}</strong></div><div className="stat"><span>Unrecorded / unknown</span><strong>{totalUnknown}</strong></div></div>
      <div className="chart" role="img" aria-label="Historical attendance utilisation by week. Each full bar represents available capacity, not bookings; exact values in the table below.">{history.map(w => <div className="chart-row" key={w.run.id}><span>{dateLabel(w.run.startsAt).split(" ").slice(0, 3).join(" ")}</span><div className="chart-track"><span className="chart-present" style={{ width: `${w.capacity ? w.present / w.capacity * 100 : 0}%` }} /><span className="chart-absent" style={{ width: `${w.capacity ? w.absent / w.capacity * 100 : 0}%` }} /><span className="chart-unknown" style={{ width: `${w.capacity ? w.unknown / w.capacity * 100 : 0}%` }} /></div></div>)}</div>
      <p className="legend"><span>● Present</span><span>● Absent</span><span>● Unknown</span></p>
      <p className="hint">100% bar width = available run capacity. The green segment is actual present ÷ capacity; unused capacity remains unfilled, and missing attendance remains unknown.</p>
      <div className="table-wrap"><table><caption>Weekly attendance and bookings</caption><thead><tr><th>Week</th><th>Capacity</th><th>Confirmed</th><th>Waitlist</th><th>Present</th><th>Absent</th><th>Unknown</th><th>Actual attendance utilisation</th><th>Attendance rate</th></tr></thead><tbody>{totals.map(w => <tr key={w.run.id}><td>{dateLabel(w.run.startsAt)}</td><td>{w.capacity}</td><td>{w.confirmed}</td><td>{w.waitlisted}</td><td>{w.present}</td><td>{w.absent}</td><td>{w.unknown}</td><td>{w.attendanceUtilisation === undefined ? "Unknown / not recorded" : `${w.attendanceUtilisation}% (lower bound)`}</td><td>{w.attendanceRate === undefined ? "Not recorded" : `${w.attendanceRate}%`}</td></tr>)}</tbody></table></div>
      {run && <div className="table-wrap"><table><caption>Selected week: group demand & actual attendance</caption><thead><tr><th>Group</th><th>Confirmed / capacity</th><th>Booking utilisation</th><th>Waitlist demand</th><th>Present</th><th>Actual attendance utilisation</th><th>Absent</th><th>Unknown</th></tr></thead><tbody>{groups.map(group => {
        const confirmed = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "confirmed");
        const actual = snapshot.attendance.filter(a => a.groupId === group.id);
        const known = new Set(actual.map(a => a.memberId));
        const present = actual.filter(a => a.outcome === "present").length;
        return <tr key={group.id}><td>Group {group.number} · {group.paceLabel}</td><td>{confirmed.length} / {group.capacity}</td><td>{Math.round(confirmed.length / group.capacity * 100)}%</td><td>{snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted").length}</td><td>{present}</td><td>{new Date(run.startsAt) > new Date() ? "Not started" : !actual.length ? "Unknown / not recorded" : `${Math.round(present / group.capacity * 100)}% (lower bound)`}</td><td>{actual.filter(a => a.outcome === "absent").length}</td><td>{confirmed.filter(b => !known.has(b.memberId)).length}</td></tr>;
      })}</tbody></table></div>}
      <h3 className="subheading">Average recorded attendees by group</h3>
      <p className="hint">Completed weeks with attendance recorded only; weeks with no attendance data are excluded.</p>
      <div className="average-attendance-chart" aria-label="Average recorded attendees by group">
        {popularity.map(group => <div className="average-attendance-row" key={group.number}>
          <span>Group {group.number}</span>
          <div className="average-attendance-track"><span style={{ width: `${maxAveragePresent ? (group.averagePresent ?? 0) / maxAveragePresent * 100 : 0}%` }} /></div>
          <strong>{group.averagePresent === undefined ? "Unknown" : group.averagePresent.toFixed(1)}</strong>
        </div>)}
      </div>
      <div className="table-wrap"><table><caption>Group popularity: average attendance and waitlist</caption><thead><tr><th>Group</th><th>Avg. recorded attendees</th><th>Avg. waitlist</th><th>Different leaders</th><th>Confirmed bookings</th><th>Recorded present</th></tr></thead><tbody>{popularity.map(g => <tr key={g.number}><td>Group {g.number}</td><td>{g.averagePresent === undefined ? "Unknown" : g.averagePresent.toFixed(1)}</td><td>{g.averageWaitlisted === undefined ? "Unknown" : g.averageWaitlisted.toFixed(1)}</td><td>{g.leaderCount}</td><td>{g.confirmed}</td><td>{g.present}</td></tr>)}</tbody></table></div>
      <h3 className="subheading">Recorded waitlist flow</h3>
      <div className="stats"><div className="stat"><span>Waitlist joins</span><strong>{queueMetrics.joins}</strong></div><div className="stat"><span>Promotions / joins</span><strong>{queueMetrics.promotions} / {queueMetrics.joins}</strong><span>{queueMetrics.promotionRate === undefined ? "No recorded joins" : `${queueMetrics.promotionRate}% promoted`}</span></div><div className="stat"><span>Peak recorded group queue</span><strong>{queueMetrics.peakQueue ?? "Unknown"}</strong><span>{queueMetrics.withdrawals} recorded withdrawals</span></div></div>
      <p className="hint">Recorded published/archived-week events only; draft and cancelled weeks are excluded. Promotion rate = promotions ÷ waitlist joins (not confirmed bookings). Peak is the maximum recorded individual-group queue, not an aggregate of all queues or today’s queue; unavailable history is never inferred.</p>
      </div>
    </details></section>
    <section className="panel"><details className="admin-disclosure" suppressHydrationWarning>
      <summary>Club members</summary>
      <div className="disclosure-content"><label>Search members<input type="search" value={search} onChange={e => { setSearch(e.target.value); setMemberPage(0); }} placeholder="Name or email" /></label>
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
