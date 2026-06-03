# Jantra Security Notes

- Gemini keys are stored through Electron `safeStorage` and are not exposed to the renderer.
- Local API calls require a per-launch loopback token.
- Hosted API mode requires API-key identity resolving to `clientId`.
- Every route must use server-derived tenancy. Callers do not supply `clientId`.
- Audit logs are append-only JSONL and may contain client context. Export them deliberately.
- Diagnostics are metadata-only by default and exclude prompts, raw artifacts, model responses, and secrets.
