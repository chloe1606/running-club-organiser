"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import type { Booking, Group, Run } from "@/lib/domain";
import { confirmedCount } from "@/lib/domain";

interface BookingGroupsProps {
  run: Run;
  groups: Group[];
  bookings: Booking[];
}

export function BookingGroups({ run, groups, bookings }: BookingGroupsProps) {
  const [message, setMessage] = useState<string>();
  const [submittingGroup, setSubmittingGroup] = useState<string>();

  async function book(group: Group) {
    setSubmittingGroup(group.id);
    setMessage(undefined);
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run.id,
          groupId: group.id,
          runVersion: run.version,
          groupVersion: group.version,
        }),
      });
      const body = (await response.json()) as {
        message?: string;
        data?: { status?: string };
      };
      if (response.status === 401) {
        await signIn("google");
        return;
      }
      setMessage(
        body.data?.status === "waitlisted"
          ? "That group is currently full; you have joined its waitlist."
          : body.message ?? "Your booking has been recorded.",
      );
    } catch {
      setMessage("We could not reach the booking service. Please try again.");
    } finally {
      setSubmittingGroup(undefined);
    }
  }

  return (
    <>
      {message && <p className="notice" role="status">{message}</p>}
      <div className="grid">
        {groups.map((group) => {
          const count = confirmedCount(group.id, bookings);
          return (
            <article className="group" key={group.id}>
              <div className="group-number">{group.number}</div>
              <div>
                <h3>{group.paceLabel}</h3>
                <p>{count} of {group.capacity} runners booked</p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={submittingGroup === group.id}
                onClick={() => void book(group)}
              >
                {submittingGroup === group.id ? "Booking..." : "Book this group"}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
