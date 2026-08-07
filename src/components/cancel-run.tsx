"use client";

import { useState } from "react";

export function CancelRun({ runId, runVersion }: { runId: string; runVersion: number }) {
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function cancelRun() {
    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/runs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, runVersion, cancellationReason: reason }),
      });
      const body = (await response.json()) as {
        message?: string;
        data?: { status?: string };
      };
      setMessage(body.message ?? (body.data?.status === "cancelled"
        ? "The run has been cancelled and its booking record retained."
        : "The cancellation could not be completed."));
    } catch {
      setMessage("We could not reach the booking service. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="cancel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void cancelRun();
      }}
    >
      <label htmlFor="reason">Cancellation reason</label>
      <textarea
        id="reason"
        minLength={3}
        required
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <button disabled={submitting} type="submit">
        {submitting ? "Cancelling..." : "Cancel this run"}
      </button>
      {message && <p className="notice" role="status">{message}</p>}
    </form>
  );
}
