import { memo } from "react";
import type { SourceView } from "../api/client";

interface Props {
  sources: SourceView[];
}

function SourceList({ sources }: Props) {
  if (!sources.length) return <p className="empty">No sources registered yet.</p>;
  return (
    <div className="source-list">
      {sources.map((source) => (
        <a href={source.url} target="_blank" rel="noreferrer" key={source.id}>
          <strong>{source.title}</strong>
          <span>{source.id}</span>
        </a>
      ))}
    </div>
  );
}

export default memo(SourceList);
