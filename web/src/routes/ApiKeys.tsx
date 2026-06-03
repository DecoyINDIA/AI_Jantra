import { Check, Copy, KeyRound, Plus, RotateCcw, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, ApiError, type ApiKeyMetadata } from "../api/client";

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function apiKeyErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "Admin is not enabled on this origin.";
  }
  return error instanceof Error ? error.message : String(error);
}

interface KeyRowProps {
  apiKey: ApiKeyMetadata;
  onRevoke: (id: string) => void;
  busy: boolean;
}

function KeyRow({ apiKey, onRevoke, busy }: KeyRowProps) {
  const revoked = Boolean(apiKey.revokedAt);
  return (
    <div className={`api-key-row ${revoked ? "is-revoked" : ""}`} role="row">
      <span>{apiKey.label}</span>
      <span>{apiKey.prefix}</span>
      <span>{apiKey.clientId}</span>
      <span>{apiKey.subject}</span>
      <span>{formatDate(apiKey.createdAt)}</span>
      <span>{formatDate(apiKey.lastUsedAt)}</span>
      <span>{revoked ? "Revoked" : "Active"}</span>
      <span>
        <button
          disabled={busy || revoked}
          onClick={() => onRevoke(apiKey.id)}
        >
          <X aria-hidden="true" /> Revoke
        </button>
      </span>
    </div>
  );
}

export default function ApiKeys() {
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [clientId, setClientId] = useState("xolver");
  const [subject, setSubject] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [copied, setCopied] = useState(false);
  const query = useMemo(
    () => `?includeRevoked=${includeRevoked ? "true" : "false"}`,
    [includeRevoked],
  );
  const keys = useQuery({
    queryKey: ["apiKeys", includeRevoked],
    queryFn: () => api.listApiKeys(query),
  });
  const create = useMutation({
    mutationFn: () => api.createApiKey({ label, clientId, subject }),
    onSuccess: (result) => {
      setCreatedKey(result.key);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["apiKeys"] }),
  });

  function closeDialog() {
    setDialogOpen(false);
    setCreatedKey("");
    setCopied(false);
    setLabel("");
    setSubject("");
  }

  function revokeKey(id: string) {
    if (window.confirm("Revoke this API key?")) revoke.mutate(id);
  }

  return (
    <section className="panel-block api-keys">
      <header className="section-head">
        <h2>API Keys</h2>
        <div className="button-row">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(event) => setIncludeRevoked(event.target.checked)}
            />
            Revoked
          </label>
          <button className="icon-only" title="Refresh" aria-label="Refresh" onClick={() => void keys.refetch()}>
            <RotateCcw aria-hidden="true" />
          </button>
          <button className="primary" onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden="true" /> Create
          </button>
        </div>
      </header>

      <div className="api-key-table" role="table">
        <div className="api-key-row head" role="row">
          <span>Label</span>
          <span>Prefix</span>
          <span>Client</span>
          <span>Subject</span>
          <span>Created</span>
          <span>Last used</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {keys.data?.items.map((item) => (
          <KeyRow
            apiKey={item}
            busy={revoke.isPending}
            key={item.id}
            onRevoke={revokeKey}
          />
        ))}
      </div>
      {keys.data?.items.length === 0 ? <p className="empty">No API keys found.</p> : null}
      {keys.isError ? <p className="error">{apiKeyErrorText(keys.error)}</p> : null}
      {revoke.isError ? <p className="error">{apiKeyErrorText(revoke.error)}</p> : null}

      {dialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="key-dialog panel-block" role="dialog" aria-modal="true" aria-labelledby="create-key-title">
            <header className="section-head">
              <h3 id="create-key-title">Create API Key</h3>
              <button className="icon-only" title="Close" aria-label="Close" onClick={closeDialog}>
                <X aria-hidden="true" />
              </button>
            </header>
            {createdKey ? (
              <div className="created-key">
                <p className="warning">Store this key now. Jantra will not show it again.</p>
                <code>{createdKey}</code>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(createdKey);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <form
                className="key-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  create.mutate();
                }}
              >
                <label>
                  Label
                  <input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={120} />
                </label>
                <label>
                  Client ID
                  <input value={clientId} onChange={(event) => setClientId(event.target.value)} required maxLength={96} />
                </label>
                <label>
                  Subject
                  <input value={subject} onChange={(event) => setSubject(event.target.value)} required maxLength={160} />
                </label>
                <button className="primary" disabled={create.isPending}>
                  <KeyRound aria-hidden="true" /> Create
                </button>
                {create.isError ? <p className="error">{apiKeyErrorText(create.error)}</p> : null}
              </form>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
