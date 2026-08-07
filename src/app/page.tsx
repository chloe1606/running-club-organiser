import { demoBookings, demoGroups, demoRun } from "@/lib/demo-data";
import { BookingGroups } from "@/components/booking-groups";

export default function HomePage() {
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(demoRun.startsAt));

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Tuesday Club Runs</p>
        <h1>Run together, every Tuesday.</h1>
        <p className="intro">
          {date} at 6:30pm. Riverside Pavilion, Meadow Lane.
        </p>
        <p className="hint">Sign in with Google when you choose a group.</p>
      </header>
      <section aria-labelledby="groups-heading" className="groups">
        <div className="section-title">
          <div>
            <p className="eyebrow">This week</p>
            <h2 id="groups-heading">Choose your pace group</h2>
          </div>
          <p>Booking closes at 5:30pm on Tuesday.</p>
        </div>
        <BookingGroups run={demoRun} groups={demoGroups} bookings={demoBookings} />
      </section>
    </main>
  );
}
