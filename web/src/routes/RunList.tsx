import { RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onOpenRun: (runId: string) => void;
}

export default function RunList({ onOpenRun }: Props) {
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns("?limit=50") });
  return (
    <section className="panel-block">
      <header className="section-head">
        <h2>Runs</h2>
        <button className="icon-only" title="Refresh" aria-label="Refresh" onClick={() => void runs.refetch()}>
          <RotateCcw aria-hidden="true" />
        </button>
      </header>
      <div className="run-table" role="table">
        <div className="run-row head" role="row">
          <span>Title</span>
          <span>Agent</span>
          <span>Status</span>
          <span>Stage</span>
          <span>Cost</span>
        </div>
        {runs.data?.items.map((run) => (
          <button className="run-row" role="row" key={run.id} onClick={() => onOpenRun(run.id)}>
            <span>{run.title}</span>
            <span>{run.agentId}</span>
            <span>{run.status}</span>
            <span>{run.currentStageStatus.replaceAll("_", " ")}</span>
            <span>${run.costUsd.toFixed(4)}</span>
          </button>
        ))}
      </div>
      {runs.isError ? <p className="error">{String(runs.error)}</p> : null}
    </section>
  );
}
