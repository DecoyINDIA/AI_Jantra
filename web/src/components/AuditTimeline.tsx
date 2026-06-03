import type { AuditEntry, RunEvent } from "../api/client";

interface Props {
  audit: AuditEntry[];
  events: RunEvent[];
}

export default function AuditTimeline({ audit, events }: Props) {
  const rows = [
    ...events.map((event) => ({
      id: event.id,
      ts: event.ts,
      type: event.type,
      text: event.message,
    })),
    ...audit.map((entry, index) => ({
      id: `${entry.runId}:${index}`,
      ts: entry.ts,
      type: entry.type,
      text: String(entry.stage ?? entry.purpose ?? entry.status ?? entry.type),
    })),
  ]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 80);

  if (!rows.length) return <p className="empty">No audit entries yet.</p>;
  return (
    <ol className="audit-list">
      {rows.map((row) => (
        <li key={row.id}>
          <time>{new Date(row.ts).toLocaleTimeString()}</time>
          <span>{row.type}</span>
          <p>{row.text}</p>
        </li>
      ))}
    </ol>
  );
}
