"use client";

import { useState } from "react";
import type { PlatformSnapshot, WeeklyLeaderImportPreview } from "@/lib/platform-types";
import { weeklyLeaderImportPreviewSchema } from "../lib/platform-schema";
import type { Mutate } from "./club-dashboard";

export function WeeklyLeaderPreview({ preview }: { preview: WeeklyLeaderImportPreview }) {
  return <>
    <p role="status">{preview.changes.length} proposed {preview.changes.length === 1 ? "change" : "changes"}; {preview.unchanged} unchanged; {preview.errors.length} {preview.errors.length === 1 ? "error" : "errors"}.</p>
    {preview.changes.length > 0 && <div className="table-wrap"><table>
      <caption>Proposed leader assignments</caption>
      <thead><tr><th scope="col">Row</th><th scope="col">Run date</th><th scope="col">Group</th><th scope="col">Current leader</th><th scope="col">Proposed leader</th></tr></thead>
      <tbody>{preview.changes.map(change => <tr key={change.row}><td>{change.row}</td><td>{change.date}</td><td>{change.groupNumber}</td><td>{change.previousLeaderName ?? "None"}</td><td>{change.leaderName}</td></tr>)}</tbody>
    </table></div>}
    {preview.errors.length > 0 && <ul role="alert">{preview.errors.map((error, index) => <li key={`${error.row}-${index}`}>Row {error.row}: {error.message}</li>)}</ul>}
  </>;
}

export function WeeklyLeaderImport({ snapshot, mutate, pending }: {
  snapshot: PlatformSnapshot; mutate: Mutate; pending: boolean;
}) {
  const [result, setResult] = useState<{ preview: WeeklyLeaderImportPreview; snapshot: PlatformSnapshot }>();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const current = snapshot.members.find(member => member.id === snapshot.currentMemberId);
  if (!current?.active || !current.roles.includes("admin") || snapshot.demo) return null;
  const stale = result && result.snapshot !== snapshot;
  const disabled = pending || loading || applying;
  async function loadPreview() {
    if (disabled) return;
    setLoading(true); setError(""); setResult(undefined);
    try {
      const response = await fetch("/api/admin/leaders/preview", { method: "POST", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The import could not be previewed.");
      const parsed = weeklyLeaderImportPreviewSchema.safeParse(body.data);
      if (!parsed.success) throw new Error("The import preview is invalid.");
      setResult({ preview: parsed.data, snapshot });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The import could not be previewed."); }
    finally { setLoading(false); }
  }
  async function apply() {
    if (disabled || !result || stale || result.preview.errors.length || !result.preview.changes.length) return;
    setApplying(true); setError("");
    try { await mutate("importWeeklyLeaders", { expectedImportFingerprint: result.preview.fingerprint }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The import could not be applied."); }
    finally { setApplying(false); }
  }
  return <details className="admin-disclosure">
    <summary>Import weekly leaders</summary>
    <div className="disclosure-content">
    <button type="button" disabled={disabled} onClick={() => void loadPreview()}>{loading ? "Checking worksheet..." : "Preview import"}</button>
    {error && <p role="alert">{error}</p>}
    {result && <>
      <WeeklyLeaderPreview preview={result.preview} />
      {stale && <p role="alert">Club data changed. Preview the import again.</p>}
      <button type="button" disabled={disabled || !!stale || result.preview.errors.length > 0 || result.preview.changes.length === 0} onClick={() => void apply()}>{applying ? "Applying import..." : "Apply leader changes"}</button>
    </>}
    </div>
  </details>;
}