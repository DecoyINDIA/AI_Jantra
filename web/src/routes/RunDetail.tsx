import { Check, FastForward, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PendingInteractionView, type RunEvent } from "../api/client";
import { subscribeRunEvents } from "../api/events";
import ArtifactViewer from "../components/ArtifactViewer";
import AuditTimeline from "../components/AuditTimeline";
import CostPanel from "../components/CostPanel";
import InteractionPanel from "../components/InteractionPanel";
import StageTimeline from "../components/StageTimeline";

interface Props {
  runId: string;
}

export default function RunDetail({ runId }: Props) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId), refetchInterval: 3000 });
  const interactions = useQuery({
    queryKey: ["interactions", runId],
    queryFn: () => api.listInteractions(runId),
    refetchInterval: 3000,
  });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getAudit(runId), refetchInterval: 5000 });
  const mutations = {
    advance: useMutation({ mutationFn: () => api.advanceRun(runId), onSuccess: () => invalidate() }),
    confirm: useMutation({ mutationFn: () => api.confirmRun(runId), onSuccess: () => invalidate() }),
    reject: useMutation({ mutationFn: () => api.rejectRun(runId, "Rejected from panel."), onSuccess: () => invalidate() }),
    answer: useMutation({
      mutationFn: (payload: { interaction: PendingInteractionView; body: { text?: string; approved?: boolean } }) =>
        api.answerInteraction(runId, payload.interaction.id, payload.body),
      onSuccess: () => invalidate(),
    }),
  };

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["interactions", runId] });
    void queryClient.invalidateQueries({ queryKey: ["audit", runId] });
  }

  useEffect(() => {
    const controller = new AbortController();
    void subscribeRunEvents(
      runId,
      (event) => setEvents((current) => [event, ...current].slice(0, 100)),
      controller.signal,
    );
    return () => controller.abort();
  }, [runId]);

  const artifacts = useMemo(
    () => Object.values(run.data?.run.stages ?? {}).flatMap((stage) => stage.artifacts),
    [run.data],
  );

  if (run.isLoading) return <p className="empty">Loading run.</p>;
  if (run.isError || !run.data) return <p className="error">{String(run.error)}</p>;
  const currentStage = run.data.run.stages[run.data.run.currentStage];
  const busy = Object.values(mutations).some((mutation) => mutation.isPending);

  return (
    <section className="run-detail">
      <div className="detail-head">
        <div>
          <span className="eyebrow">{run.data.run.agentDefinitionSnapshot.name}</span>
          <h1>{run.data.run.title}</h1>
        </div>
        <div className="button-row">
          <button disabled={busy || run.data.run.status !== "active"} onClick={() => mutations.advance.mutate()}>
            <FastForward aria-hidden="true" /> Advance
          </button>
          <button
            className="primary"
            disabled={busy || currentStage?.status !== "awaiting_confirmation"}
            onClick={() => mutations.confirm.mutate()}
          >
            <Check aria-hidden="true" /> Confirm
          </button>
          <button disabled={busy || run.data.run.status !== "active"} onClick={() => mutations.reject.mutate()}>
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
              onAnswer={(interaction, body) => mutations.answer.mutate({ interaction, body })}
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
            <div className="source-list">
              {run.data.run.sources.length ? (
                run.data.run.sources.map((source) => (
                  <a href={source.url} target="_blank" rel="noreferrer" key={source.id}>
                    <strong>{source.title}</strong>
                    <span>{source.id}</span>
                  </a>
                ))
              ) : (
                <p className="empty">No sources registered yet.</p>
              )}
            </div>
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
