import { Play } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onOpenRun: (runId: string) => void;
}

export default function AgentCatalog({ onOpenRun }: Props) {
  const queryClient = useQueryClient();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const createRun = useMutation({
    mutationFn: (body: { agentId: string; title: string }) => api.createRun(body),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      onOpenRun(result.run.id);
    },
  });

  return (
    <section className="view-grid">
      {agents.data?.agents.map((agent) => (
        <article className="agent-tile" key={agent.id}>
          <div>
            <span className="eyebrow">v{agent.version}</span>
            <h2>{agent.name}</h2>
            <p>{agent.description}</p>
          </div>
          <div className="start-row">
            <input
              value={titles[agent.id] ?? ""}
              placeholder="Run title"
              onChange={(event) =>
                setTitles((current) => ({ ...current, [agent.id]: event.target.value }))
              }
            />
            <button
              className="primary icon-only"
              title="Start run"
              aria-label={`Start ${agent.name}`}
              disabled={createRun.isPending}
              onClick={() =>
                createRun.mutate({
                  agentId: agent.id,
                  title: titles[agent.id]?.trim() || agent.name,
                })
              }
            >
              <Play aria-hidden="true" />
            </button>
          </div>
        </article>
      ))}
      {agents.isError ? <p className="error">{String(agents.error)}</p> : null}
    </section>
  );
}
