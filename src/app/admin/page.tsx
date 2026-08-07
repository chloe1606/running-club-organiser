import { CancelRun } from "@/components/cancel-run";
import { demoBookings, demoGroups, demoRun } from "@/lib/demo-data";
import { confirmedCount } from "@/lib/domain";

export default function AdminPage() {
  const booked = demoGroups.reduce(
    (total, group) => total + confirmedCount(group.id, demoBookings),
    0,
  );
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Administrator</p>
        <h1>Run control</h1>
        <p className="intro">{booked} runners are currently confirmed across 13 groups.</p>
      </header>
      <section className="groups">
        <h2>Cancel an under-subscribed run</h2>
        <p className="hint">
          Cancelling closes all active bookings, preserves a historical record, and frees the next
          future run to be published.
        </p>
        <CancelRun runId={demoRun.id} runVersion={demoRun.version} />
      </section>
    </main>
  );
}
