const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const trailingPunctuation = /[.,!?;:)\]]+$/;

export function RouteDescription({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(urlPattern)) {
    const raw = match[0];
    const start = match.index!;
    const candidate = raw.replace(trailingPunctuation, "");
    if (!candidate) continue;

    let validUrl = false;
    try {
      const parsed = new URL(candidate);
      validUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      validUrl = false;
    }
    if (!validUrl) continue;

    parts.push(text.slice(cursor, start));
    parts.push(<a className="route-link" key={`url-${start}`} href={candidate} title={candidate} target="_blank" rel="noopener noreferrer">{candidate}</a>);
    parts.push(raw.slice(candidate.length));
    cursor = start + raw.length;
  }

  if (cursor === 0) return <>{text}</>;
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}