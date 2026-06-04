import { Check, FastForward, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PendingInteractionView, type RunEvent } from "../api/client";
import { subscribeRunEvents } from "../api/events";
import ArtifactViewer from "../components/ArtifactViewer";
import AuditTimeline from "../components/AuditTimeline";
import CostPanel from "../components/CostPanel";
import InteractionPanel from "../components/InteractionPanel";
import SourceList from "../components/SourceList";
import StageTimeline from "../components/StageTimeline";

interface Props {
  runId: string;
}

export default function RunDetail({ runId }: Props) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const pendingEvents = useRef<RunEvent[]>([]);
  const eventFrame = useRef<number | null>(null);
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId), refetchInterval: 3000 });
  const interactions = useQuery({
    queryKey: ["interactions", runId],
    queryFn: () => api.listInteractions(runId),
    refetchInterval: 3000,
  });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getAudit(runId), refetchInterval: 5000 });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["interactions", runId] });
    void queryClient.invalidateQueries({ queryKey: ["audit", runId] });
  }, [queryClient, runId]);

  const advance = useMutation({ mutationFn: () => api.advanceRun(runId), onSuccess: invalidate });
  const confirm = useMutation({ mutationFn: () => api.confirmRun(runId), onSuccess: invalidate });
  const reject = useMutation({ mutationFn: () => api.rejectRun(runId, "Rejected from panel."), onSuccess: invalidate });
  const answer = useMutation({
    mutationFn: (payload: { interaction: PendingInteractionView; body: { text?: string; approved?: boolean } }) =>
      api.answerInteraction(runId, payload.interaction.id, payload.body),
    onSuccess: invalidate,
  });

  const answerInteraction = answer.mutate;
  const handleAnswer = useCallback(
    (interaction: PendingInteractionView, body: { text?: string; approved?: boolean }) =>
      answerInteraction({ interaction, body }),
    [answerInteraction],
  );

  const scheduleEventUpdate = useCallback((event: RunEvent) => {
    pendingEvents.current.push(event);
    if (eventFrame.current !== null) return;
    eventFrame.current = window.requestAnimationFrame(() => {
      eventFrame.current = null;
      const batch = pendingEvents.current.splice(0);
      if (!batch.length) return;
      setEvents((current) => [...batch.reverse(), ...current].slice(0, 100));
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    pendingEvents.current = [];
    setEvents([]);
    void subscribeRunEvents(runId, scheduleEventUpdate, controller.signal).catch(() => {
      // Polling remains the fallback when the optional live event stream is unavailable.
    });
    return () => {
      controller.abort();
      pendingEvents.current = [];
      if (eventFrame.current !== null) {
        window.cancelAnimationFrame(eventFrame.current);
        eventFrame.current = null;
      }
    };
  }, [runId, scheduleEventUpdate]);

  const artifacts = useMemo(
    () => Object.values(run.data?.run.stages ?? {}).flatMap((stage) => stage.artifacts),
    [run.data],
  );

  if (run.isLoading) return <p className="empty">Loading run.</p>;
  if (run.isError || !run.data) return <p className="error">{String(run.error)}</p>;
  const currentStage = run.data.run.stages[run.data.run.currentStage];
  const busy = advance.isPending || confirm.isPending || reject.isPending || answer.isPending;

  return (
    <section className="run-detail">
      <div className="detail-head">
        <div>
          <span className="eyebrow">{run.data.run.agentDefinitionSnapshot.name}</span>
          <h1>{run.data.run.title}</h1>
        </div>
        <div className="button-row">
          <button disabled={busy || run.data.run.status !== "active"} onClick={() => advance.mutate()}>
            <FastForward aria-hidden="true" /> Advance
          </button>
          <button
            className="primary"
            disabled={busy || currentStage?.status !== "awaiting_confirmation"}
            onClick={() => confirm.mutate()}
          >
            <Check aria-hidden="true" /> Confirm
          </button>
          <button disabled={busy || run.data.run.status !== "active"} onClick={() => reject.mutate()}>
            <X aria-hidden="true" /> Reject
          </button>
        </div>
      </div>
      <div className="detail-grid">
        <aside className="left-rail">
          <StageTimeline run={run.data.run} />
          <CostPanel cost={run.data.run.cost} />
          <section className="panel-block">
            <h2>Interactions</h2>
            <InteractionPanel
              interactions={interactions.data?.interactions ?? []}
              busy={busy}
              onAnswer={handleAnswer}
            />
          </section>
        </aside>
        <main className="main-stack">
          <section className="panel-block">
            <h2>Artifacts</h2>
            <ArtifactViewer artifacts={artifacts} />
          </section>
          <section className="panel-block">
            <h2>Sources</h2>
            <SourceList sources={run.data.run.sources} />
          </section>
          <section className="panel-block">
            <h2>Audit</h2>
            <AuditTimeline audit={audit.data?.items ?? []} events={events} />
          </section>
        </main>
      </div>
    </section>
  );
}
