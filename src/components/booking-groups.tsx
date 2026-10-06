"use client";

import Link from "next/link";
import { useState } from "react";
import type { Group, Run } from "../lib/domain";
import { bookingIsOpen, confirmedCount } from "../lib/domain";
import type { PlatformSnapshot } from "../lib/platform-types";
import { queuePosition } from "../lib/analytics";
import type { Mutate } from "./club-dashboard";

export function BookingGroups({ snapshot, run, groups, mutate, pending }: {
  snapshot: PlatformSnapshot; run: Run; groups: Group[]; mutate: Mutate; pending: boolean;
}) {
  const own = snapshot.bookings.find(b => b.runId === run.id && b.memberId === snapshot.currentMemberId && b.status !== "cancelled");
  const open = bookingIsOpen(run, new Date());
  const currentMember = snapshot.members.find(member => member.id === snapshot.currentMemberId);
  const canVolunteerAsSweeper = Boolean(currentMember?.active && currentMember.roles.includes("runner") && currentMember.roles.includes("sweeper"));
  const [sweeperOptIns, setSweeperOptIns] = useState<Record<string, boolean>>({});
  return <section className="groups">
    <div className="section-title"><div><p className="eyebrow">Find your people</p><h2>Choose your pace group</h2></div><p>{groups.length} groups · {own ? "You have a booking this week" : "One group per runner"}</p></div>
    {own && <p className="notice">Your booking: Group {snapshot.groups.find(g => g.id === own.groupId)?.number} · {own.status === "waitlisted" ? `waitlist position #${queuePosition(snapshot, own.groupId, own.memberId)} (not confirmed)` : "confirmed"}{own.source === "assignment" && " · assigned volunteer; ask an administrator to change this assignment."}</p>}
    {!open && <p className="notice">Booking is closed for this week. You can still view group information.</p>}
    <div className="grid">{groups.map(group => {
      const count = confirmedCount(group.id, snapshot.bookings);
      const spaces = Math.max(0, group.capacity - count);
      const waitlist = snapshot.bookings.filter(b => b.groupId === group.id && b.status === "waitlisted").length;
      const mine = own?.groupId === group.id;
      const leader = snapshot.members.find(m => m.id === group.leaderId)?.name;
      const sweeper = snapshot.members.find(m => m.id === group.sweeperId)?.name;
      const sweeperOptIn = sweeperOptIns[group.id] ?? false;
      return <article className={`group ${mine ? "my-group" : ""}`} key={group.id}>
        <div className="group-top"><span className="group-number">{String(group.number)}</span><span className={`availability ${spaces === 0 ? "full" : spaces < 5 ? "amber" : "green"}`}>{spaces === 0 ? "Full · waitlist" : `${spaces} places left`}</span></div>
        <h3>{group.name ?? `Group ${group.number}`}</h3><p className="pace">{group.paceLabel}</p><p>{group.distanceLabel ?? "Distance to be confirmed"}</p>
        <div className="occupancy"><span style={{ width: `${Math.min(100, count / group.capacity * 100)}%` }} /></div>
        <p>{count}/{group.capacity} confirmed · Waitlist: {waitlist}</p>
        <div className="volunteers"><p>Leader · <strong>{leader ?? (group.leaderId ? "Assigned club leader" : "To be assigned")}</strong></p><p>Sweeper · {sweeper ?? (group.sweeperId ? "Assigned club member" : "Not assigned")}</p></div>
        {snapshot.currentMemberId && canVolunteerAsSweeper && !mine && <label className="check sweeper-opt-in"><input type="checkbox" checked={sweeperOptIn} disabled={pending || !open || spaces === 0} onChange={event => setSweeperOptIns(value => ({ ...value, [group.id]: event.target.checked }))} />I can be this group’s sweeper</label>}
        {snapshot.currentMemberId && canVolunteerAsSweeper && sweeperOptIn && spaces === 0 && !mine && <p className="hint">Sweeper volunteers need a confirmed place; this group is full.</p>}
        <p className="route-summary">{group.routeNeedsReview ? "Route needs review" : group.routeDescription ? group.routeDescription : "Route to be confirmed"}</p>
        {snapshot.currentMemberId ? <Link className="details-link" href={`/groups/${encodeURIComponent(group.id)}`}>Route, runners & waitlist →</Link> : <Link href="/auth/signin">Sign in for group details</Link>}
        {snapshot.currentMemberId ? <button disabled={pending || !open || own?.source === "assignment"} className={mine ? "secondary" : ""} onClick={() => {
          if (own && !mine && !spaces && !window.confirm("This group is full. Switching will release your current booking or queue place and join the destination waitlist. You will not have a confirmed place. Continue?")) return;
          void mutate(mine ? "leave" : own ? "switchGroup" : "book", mine
            ? { runId: run.id, runVersion: run.version }
            : { runId: run.id, runVersion: run.version, groupId: group.id, groupVersion: group.version,
              ...(canVolunteerAsSweeper ? { sweeper: sweeperOptIn } : {}) });
        }}>{pending ? "Saving…" : mine ? "Leave this group" : own ? (spaces ? "Switch to this group" : "Switch to waitlist") : spaces ? "Join this group" : "Join waitlist"}</button> : <Link className="button" href="/auth/signin">Sign in to book</Link>}
      </article>;
    })}</div>
  </section>;
}
