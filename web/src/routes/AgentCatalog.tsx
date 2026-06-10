import { Play } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

interface Props {
  onOpenRun: (runId: string) => void;
}

// Sentinel for "use the server-configured default model" (no modelId sent).
const DEFAULT_MODEL = "";

export default function AgentCatalog({ onOpenRun }: Props) {
  const queryClient = useQueryClient();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const modelOptions = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const createRun = useMutation({
    mutationFn: (body: { agentId: string; title: string; modelId?: string }) => api.createRun(body),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      onOpenRun(result.run.id);
    },
  });

  const options = modelOptions.data?.models ?? [];

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
            <select
              aria-label="Model"
              title="Model"
              value={models[agent.id] ?? DEFAULT_MODEL}
              onChange={(event) =>
                setModels((current) => ({ ...current, [agent.id]: event.target.value }))
              }
            >
              <option value={DEFAULT_MODEL}>Default model</option>
              {options.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.label}
                  {model.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
            <button
              className="primary icon-only"
              title="Start run"
              aria-label={`Start ${agent.name}`}
              disabled={createRun.isPending}
              onClick={() => {
                const modelId = models[agent.id];
                createRun.mutate({
                  agentId: agent.id,
                  title: titles[agent.id]?.trim() || agent.name,
                  ...(modelId ? { modelId } : {}),
                });
              }}
            >
              <Play aria-hidden="true" />
            </button>
          </div>
        </article>
      ))}
      {agents.isError ? <p className="error">{String(agents.error)}</p> : null}
      {modelOptions.isError ? <p className="error">{String(modelOptions.error)}</p> : null}
    </section>
  );
}
