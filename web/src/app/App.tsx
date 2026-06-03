import { Boxes, ListChecks, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import AgentCatalog from "../routes/AgentCatalog";
import RunDetail from "../routes/RunDetail";
import RunList from "../routes/RunList";
import Settings from "../routes/Settings";

type View = "agents" | "runs" | "settings";

export default function App() {
  const [view, setView] = useState<View>("agents");
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <div className="app-shell">
      <nav className="side-nav" aria-label="Main">
        <div className="brand">
          <strong>Jantra</strong>
          <span>AI</span>
        </div>
        <button
          className={view === "agents" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("agents");
          }}
        >
          <Boxes aria-hidden="true" /> Agents
        </button>
        <button
          className={view === "runs" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("runs");
          }}
        >
          <ListChecks aria-hidden="true" /> Runs
        </button>
        <button
          className={view === "settings" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("settings");
          }}
        >
          <SettingsIcon aria-hidden="true" /> Settings
        </button>
      </nav>
      <div className="content">
        {runId ? (
          <RunDetail runId={runId} />
        ) : view === "agents" ? (
          <AgentCatalog
            onOpenRun={(id) => {
              setRunId(id);
              setView("runs");
            }}
          />
        ) : view === "runs" ? (
          <RunList onOpenRun={setRunId} />
        ) : (
          <Settings />
        )}
      </div>
    </div>
  );
}
