"use client";

import { useId, useState } from "react";
import type { MemberInvitationResult, PlatformSnapshot } from "@/lib/platform-types";
import type { Mutate } from "./club-dashboard";

const roles = ["runner", "leader", "sweeper", "admin"] as const;

export function MemberOnboarding({ snapshot, mutate, pending }: {
  snapshot: PlatformSnapshot; mutate: Mutate; pending: boolean;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["runner", "sweeper"]);
  const [active, setActive] = useState(true);
  const [sendInvitation, setSendInvitation] = useState(true);
  const [invitation, setInvitation] = useState<MemberInvitationResult>();
  const [inviting, setInviting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const current = snapshot.members.find(member => member.id === snapshot.currentMemberId);
  if (!current?.active || !current.roles.includes("admin")) return null;
  const duplicate = snapshot.members.some(member => member.email.trim().toLowerCase() === email.trim().toLowerCase());
  const disabled = pending || submitting || inviting;
  async function retryInvitation() {
    if (!invitation || disabled) return;
    setInviting(true);
    try {
      const response = await fetch("/api/admin/members/invite", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: invitation.memberId }) });
      const body = await response.json();
      if (!response.ok || !body.invitation) throw new Error(body.message ?? "The invitation could not be confirmed. Retry to check Clerk before sending again.");
      setInvitation(body.invitation);
    } catch (failure) {
      setInvitation({ ...invitation, status: "failed", message: failure instanceof Error ? failure.message : "The invitation could not be confirmed. Please retry." });
    } finally { setInviting(false); }
  }
  return <details className="admin-disclosure">
    <summary>Add member</summary>
    <div className="disclosure-content">
    <form className="member-editor" onSubmit={async event => {
      event.preventDefault();
      if (disabled || duplicate || !selectedRoles.length) return;
      setSubmitting(true); setError(""); setSaved(false); setInvitation(undefined);
      try {
        await mutate("addMember", { name: name.trim(), memberEmail: email.trim().toLowerCase(), roles: selectedRoles, active, sendInvitation: active && sendInvitation }, result => {
          setSaved(true); setInvitation(result); setName(""); setEmail("");
        });
      } catch (failure) { setError(failure instanceof Error ? failure.message : "The member could not be added."); }
      finally { setSubmitting(false); }
    }}>
      <fieldset disabled={disabled}>
        <label htmlFor={`${id}-name`}>Full name<input id={`${id}-name`} autoComplete="name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        <label htmlFor={`${id}-email`}>Email<input id={`${id}-email`} type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Roles</legend>
        {roles.map(role => <label key={role}><input type="checkbox" checked={selectedRoles.includes(role)} onChange={event => setSelectedRoles(event.target.checked ? [...selectedRoles, role] : selectedRoles.filter(value => value !== role))} />{role[0].toUpperCase() + role.slice(1)}</label>)}
      </fieldset>
      <label><input type="checkbox" disabled={disabled} checked={active} onChange={event => setActive(event.target.checked)} />Active</label>
      <label><input type="checkbox" disabled={disabled || !active} checked={active && sendInvitation} onChange={event => setSendInvitation(event.target.checked)} />Send account invitation</label>
      <p className="hint">{snapshot.demo ? "Demo only: no invitation emails will be sent." : "Active membership is saved first. Existing Clerk accounts and pending invitations are skipped."}</p>
      {duplicate && <p role="alert">A member with this email already exists.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={disabled || duplicate || !selectedRoles.length || !name.trim()}>{submitting ? "Adding member..." : "Add member"}</button>
    </form>
    {saved && <p role={invitation?.status === "failed" ? "alert" : "status"}>Member added. {invitation?.message ?? "No invitation requested."} {invitation?.status === "failed" && "Membership is saved; retrying will not add another member."}</p>}
    {invitation?.status === "failed" && <button type="button" disabled={disabled} onClick={() => void retryInvitation()}>{inviting ? "Checking invitation..." : "Retry invitation"}</button>}
    </div>
  </details>;
}