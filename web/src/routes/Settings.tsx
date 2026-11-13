import { Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { getApiConfig, isRememberEnabled, saveApiConfig } from "../api/client";

export default function Settings() {
  const current = getApiConfig();
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [token, setToken] = useState(current.token);
  const [newAdminToken, setNewAdminToken] = useState("");
  const [hasExistingAdmin, setHasExistingAdmin] = useState(Boolean(current.adminToken));
  const [rememberOnDevice, setRememberOnDevice] = useState(isRememberEnabled());
  const [desktopResult, setDesktopResult] = useState("");
  const [saved, setSaved] = useState(false);
  const desktop = window.jantraDesktop;

  const handleSave = () => {
    saveApiConfig({
      baseUrl,
      token,
      adminToken: newAdminToken ? newAdminToken : (hasExistingAdmin ? current.adminToken : ""),
      remember: rememberOnDevice,
    });
    setNewAdminToken("");
    if (newAdminToken) setHasExistingAdmin(true);
    setSaved(true);
  };

  const handleClearAdminToken = () => {
    setHasExistingAdmin(false);
    setNewAdminToken("");
    saveApiConfig({
      baseUrl,
      token,
      adminToken: "",
      remember: rememberOnDevice,
    });
    setSaved(true);
  };

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
      <label>
        Admin token
        <input
          value={newAdminToken}
          onChange={(event) => setNewAdminToken(event.target.value)}
          type="password"
          placeholder={hasExistingAdmin ? "•••••••• (configured - leave blank to keep)" : "Enter admin token"}
          autoComplete="new-password"
        />
      </label>
      {hasExistingAdmin ? (
        <div className="button-row" style={{ marginTop: "-0.5rem", marginBottom: "0.5rem" }}>
          <button type="button" onClick={handleClearAdminToken}>
            <Trash2 aria-hidden="true" /> Clear stored admin token
          </button>
        </div>
      ) : null}
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", marginTop: "0.5rem" }}>
        <input
          type="checkbox"
          checked={rememberOnDevice}
          onChange={(event) => setRememberOnDevice(event.target.checked)}
        />
        Remember tokens on this device (stores in persistent localStorage instead of sessionStorage)
      </label>
      <p className="empty">
        By default, operator tokens are stored in sessionStorage only and expire when the browser tab closes.
        Admin tokens are never rendered back into input fields.
      </p>
      <button
        className="primary"
        onClick={handleSave}
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
