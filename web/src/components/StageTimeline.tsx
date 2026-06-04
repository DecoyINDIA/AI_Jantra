import { CheckCircle2, Circle, Clock3, OctagonAlert, PauseCircle } from "lucide-react";
import { memo } from "react";
import type { RunDetail } from "../api/client";

interface Props {
  run: RunDetail;
}

function statusIcon(status: string) {
  if (status === "confirmed") return <CheckCircle2 aria-hidden="true" />;
  if (status === "awaiting_confirmation") return <PauseCircle aria-hidden="true" />;
  if (status === "awaiting_input") return <Clock3 aria-hidden="true" />;
  if (status === "rejected") return <OctagonAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function StageTimeline({ run }: Props) {
  return (
    <ol className="timeline" aria-label="Stages">
      {run.agentDefinitionSnapshot.stages.map((stage) => {
        const state = run.stages[stage.id];
        const status = state?.status ?? (stage.enabled ? "pending" : "skipped");
        const current = run.currentStage === stage.id && run.status === "active";
        return (
          <li className={`timeline-item ${current ? "is-current" : ""}`} key={stage.id}>
            <span className={`stage-dot status-${status}`}>{statusIcon(status)}</span>
            <span>
              <strong>{stage.title}</strong>
              <small>{status.replaceAll("_", " ")}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default memo(StageTimeline);
