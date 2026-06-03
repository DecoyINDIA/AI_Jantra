import { Save } from "lucide-react";
import { useState } from "react";
import { getApiConfig, saveApiConfig } from "../api/client";

export default function Settings() {
  const current = getApiConfig();
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [token, setToken] = useState(current.token);
  const [desktopResult, setDesktopResult] = useState("");
  const [saved, setSaved] = useState(false);
  const desktop = window.jantraDesktop;
  return (
    <section className="settings panel-block">
      <h2>Settings</h2>
      <label>
        API base URL
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      <label>
        Loopback token
        <input value={token} onChange={(event) => setToken(event.target.value)} />
      </label>
      <button
        className="primary"
        onClick={() => {
          saveApiConfig({ baseUrl, token });
          setSaved(true);
        }}
      >
        <Save aria-hidden="true" /> Save
      </button>
      {saved ? <p className="empty">Saved.</p> : null}
      {desktop ? (
        <div className="desktop-tools">
          <h3>Desktop</h3>
          <div className="button-row">
            <button
              onClick={async () => setDesktopResult(await desktop.createBackup())}
            >
              Backup
            </button>
            <button
              onClick={async () => setDesktopResult(await desktop.collectDiagnostics())}
            >
              Diagnostics
            </button>
            <button
              onClick={async () => setDesktopResult(await desktop.exportAudit("xolver"))}
            >
              Export audit
            </button>
          </div>
          {desktopResult ? <p className="empty">{desktopResult}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
