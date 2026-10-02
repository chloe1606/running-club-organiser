"use client";
import { useState } from "react";
import type { Mutate } from "./club-dashboard";

export function CancelRun({ runId, runVersion, mutate, pending }: {
  runId: string; runVersion: number; mutate: Mutate; pending: boolean;
}) {
  const [reason, setReason] = useState("");
  return <form className="cancel-form" onSubmit={e => { e.preventDefault(); void mutate("cancelRun", { runId, runVersion, cancellationReason: reason }); }}>
    <label htmlFor={`reason-${runId}`}>Cancellation reason (visible to runners)</label>
    <textarea id={`reason-${runId}`} minLength={3} required value={reason} onChange={e => setReason(e.target.value)} />
    <button className="danger" disabled={pending} type="submit">Cancel selected week & all bookings</button>
  </form>;
}
