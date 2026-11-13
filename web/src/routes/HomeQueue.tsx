import { ArrowRight, Clock, Inbox, RotateCcw, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type LeadView, type RunSummary } from "../api/client";

interface Props {
  onOpenRun: (runId: string) => void;
}

export default function HomeQueue({ onOpenRun }: Props) {
  const queryClient = useQueryClient();
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns("?status=active&limit=100"),
  });

  const leads = useQuery({
    queryKey: ["leads"],
    queryFn: () => api.listLeads(),
  });

  const promoteMutation = useMutation({
    mutationFn: (runId: string) => api.promoteRun(runId),
    onSuccess: (data) => {
      setPromoteError(null);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      onOpenRun(data.run.id);
    },
    onError: (err) => {
      setPromoteError(err instanceof Error ? err.message : String(err));
    },
  });

  const waitingRuns: RunSummary[] = (runs.data?.items ?? [])
    .filter(
      (run) =>
        run.currentStageStatus === "awaiting_confirmation" ||
        run.currentStageStatus === "awaiting_input",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // Oldest first

  const leadItems: LeadView[] = leads.data?.items ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Gate Queue Section */}
      <section className="panel-block">
        <header className="section-head">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Clock aria-hidden="true" style={{ width: "20px", height: "20px", color: "var(--amber)" }} />
            <h2 style={{ margin: 0 }}>Gate Queue</h2>
            <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: 500 }}>
              ({waitingRuns.length} awaiting human review)
            </span>
          </div>
          <button
            className="icon-only"
            title="Refresh"
            aria-label="Refresh queue"
            onClick={() => {
              void runs.refetch();
              void leads.refetch();
            }}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </header>

        {waitingRuns.length === 0 ? (
          <p style={{ color: "var(--muted)", padding: "16px 8px", margin: 0 }}>
            No runs currently awaiting human review. Runs paused at a human gate or interaction prompt will appear here.
          </p>
        ) : (
          <div className="run-table" role="table">
            <div className="run-row head" role="row">
              <span>Title</span>
              <span>Agent</span>
              <span>Status</span>
              <span>Stage</span>
              <span>Cost</span>
            </div>
            {waitingRuns.map((run) => (
              <button
                className="run-row"
                role="row"
                key={run.id}
                onClick={() => onOpenRun(run.id)}
                title="Open run review"
              >
                <span>{run.title}</span>
                <span>{run.agentId}</span>
                <span style={{ color: "var(--amber)", fontWeight: 600 }}>
                  {run.currentStageStatus.replaceAll("_", " ")}
                </span>
                <span>{run.currentStage}</span>
                <span>${run.costUsd.toFixed(4)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Lead Inbox Section */}
      <section className="panel-block">
        <header className="section-head">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Inbox aria-hidden="true" style={{ width: "20px", height: "20px", color: "var(--blue)" }} />
            <h2 style={{ margin: 0 }}>Lead Inbox</h2>
            <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: 500 }}>
              ({leadItems.length} leads)
            </span>
          </div>
        </header>

        {promoteError ? (
          <div style={{ padding: "8px 12px", background: "#fff2f0", color: "var(--red)", borderRadius: "6px", margin: "12px 0", fontSize: "14px" }}>
            Promotion failed: {promoteError}
          </div>
        ) : null}

        {leadItems.length === 0 ? (
          <p style={{ color: "var(--muted)", padding: "16px 8px", margin: 0 }}>
            No leads captured yet. Leads submitted through the intake widget will appear here.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            {leadItems.map((lead) => (
              <div
                key={lead.id}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: "8px",
                  padding: "14px 16px",
                  background: "var(--panel-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                  <div>
                    <strong style={{ fontSize: "15px" }}>{lead.name}</strong>
                    <span style={{ color: "var(--muted)", marginLeft: "8px", fontSize: "13px" }}>
                      &lt;{lead.email}&gt;
                    </span>
                    {lead.phone ? (
                      <span style={{ color: "var(--muted)", marginLeft: "8px", fontSize: "13px" }}>
                        · {lead.phone}
                      </span>
                    ) : null}
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </span>
                </div>

                <p
                  style={{
                    margin: "4px 0",
                    fontSize: "14px",
                    color: "var(--ink)",
                    whiteSpace: "pre-wrap",
                    maxHeight: "80px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {lead.idea}
                </p>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                    Source: {lead.source} {lead.runId ? `· Run ${lead.runId.slice(0, 8)}...` : ""}
                  </span>

                  {lead.runId ? (
                    <button
                      className="primary"
                      style={{ fontSize: "13px", padding: "6px 14px", minHeight: "32px" }}
                      disabled={promoteMutation.isPending}
                      onClick={() => promoteMutation.mutate(lead.runId!)}
                    >
                      <Sparkles aria-hidden="true" style={{ width: "15px", height: "15px" }} />
                      {promoteMutation.isPending ? "Promoting..." : "Promote to Full Plan"}
                      <ArrowRight aria-hidden="true" style={{ width: "14px", height: "14px" }} />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
