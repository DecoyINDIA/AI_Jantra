# Jantra Embedding Guide

Use hosted mode only with API-key auth enabled.

```ts
import { JantraClient } from "@jantra/client";

const jantra = new JantraClient({
  baseUrl: "https://jantra.example.com",
  apiKey: "partner-api-key",
});

const run = await jantra.createRun("planning-pipeline", "New product idea", "Idea text");
```

For read-mostly embedding, mount the widget:

```ts
import { mountJantraRunWidget } from "@jantra/embed-widget";

await mountJantraRunWidget({
  container: document.querySelector("#jantra-run")!,
  baseUrl: "https://jantra.example.com",
  apiKey: "partner-api-key",
  runId: "run-id",
});
```

API keys map to a server-side `clientId`. Cross-tenant reads are blocked by the API edge and store queries.
