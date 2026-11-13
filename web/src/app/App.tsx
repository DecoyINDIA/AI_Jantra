import { Boxes, Inbox, KeyRound, ListChecks, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import AgentCatalog from "../routes/AgentCatalog";
import ApiKeys from "../routes/ApiKeys";
import HomeQueue from "../routes/HomeQueue";
import RunDetail from "../routes/RunDetail";
import RunList from "../routes/RunList";
import Settings from "../routes/Settings";

type View = "queue" | "runs" | "agents" | "apiKeys" | "settings";

export default function App() {
  const [view, setView] = useState<View>("queue");
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <div className="app-shell">
      <nav className="side-nav" aria-label="Main">
        <div className="brand">
          <img src="/logo.png" alt="Jantra Logo" className="brand-logo" />
          <strong>Jantra</strong>
          <span>AI</span>
        </div>
        <button
          className={view === "queue" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("queue");
          }}
        >
          <Inbox aria-hidden="true" /> Queue & Leads
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
          className={view === "agents" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("agents");
          }}
        >
          <Boxes aria-hidden="true" /> Agents
        </button>
        <button
          className={view === "apiKeys" ? "active" : ""}
          onClick={() => {
            setRunId(null);
            setView("apiKeys");
          }}
        >
          <KeyRound aria-hidden="true" /> API Keys
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
        ) : view === "queue" ? (
          <HomeQueue
            onOpenRun={(id) => {
              setRunId(id);
              setView("runs");
            }}
          />
        ) : view === "agents" ? (
          <AgentCatalog
            onOpenRun={(id) => {
              setRunId(id);
              setView("runs");
            }}
          />
        ) : view === "runs" ? (
          <RunList onOpenRun={setRunId} />
        ) : view === "apiKeys" ? (
          <ApiKeys />
        ) : (
          <Settings />
        )}
      </div>
    </div>
  );
}
