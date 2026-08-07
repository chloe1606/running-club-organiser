const participants = ["Alex Morgan", "Priya Shah"];

export default function LeaderPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Leader workspace</p>
        <h1>Group 1 roster</h1>
        <p className="intro">Riverside Pavilion, Tuesday at 6:30pm.</p>
      </header>
      <section className="groups">
        <h2>Confirmed runners</h2>
        <ul className="roster">
          {participants.map((name) => <li key={name}>{name}</li>)}
        </ul>
        <label className="route-label" htmlFor="route">Planned route</label>
        <textarea id="route" placeholder="Add the route description or link." />
      </section>
    </main>
  );
}
