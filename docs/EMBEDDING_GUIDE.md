# Jantra Embedding Guide

Jantra is embeddable as a service: a host site talks to a Jantra base URL and
gets a live agent. Xolver is the first consumer (its site embeds the intake
agent), and the same path works for any other site.

## Public embedding (browser, no secret)

For a public site, do not ship an API key in the browser. Put the Cloudflare
Worker edge in front (see `deploy/cloudflare-worker/`), which holds the key and
allowlists your origin. The widget then needs only the edge base URL.

If the edge has Turnstile enabled, pass the matching `turnstileSiteKey`. The
widget loads Cloudflare's Turnstile script and fetches a fresh token before it
starts a run or saves a lead; most visitors see no challenge. If your site uses
a Content Security Policy, allow `https://challenges.cloudflare.com` in
`script-src` and `frame-src`.

```ts
import { mountJantraIntakeWidget } from "@jantra/embed-widget";

mountJantraIntakeWidget({
  container: document.querySelector("#jantra-intake")!,
  baseUrl: "https://api.jantra.in", // the Worker edge
  agentId: "intake-public",          // intake only; never advances to research/planning
  theme: { accent: "#1C2E1E", muted: "#738273", fontFamily: "'Inter', sans-serif" },
  requestTimeoutMs: 20000,
  maxMessageChars: 2000,
  turnstileSiteKey: "0x4AAAA...",    // when the edge sets TURNSTILE_SECRET_KEY
  onComplete: (summary) => {
    // The lead also persists server-side on Jantra. Optionally react here.
    console.log(summary.title, summary.content);
  },
});
```

The widget drives the run/interaction loop itself: it creates a run, asks the
agent's questions, takes the visitor's answers, and renders the final idea
summary. It is framework-agnostic vanilla DOM and themeable via design tokens.
It also caps visitor answers, times out slow requests, retries transient
failures, and shows a retry state instead of exposing transport errors as chat
content.

## Trusted / server contexts (with a key)

When the caller is trusted (a backend, or hosted mode with API-key auth), use
the SDK directly:

```ts
import { JantraClient } from "@jantra/client";

const jantra = new JantraClient({
  baseUrl: "https://jantra.example.com",
  apiKey: "partner-api-key",
});

const run = await jantra.createRun("intake-public", "New product idea", "Idea text");
```

For read-mostly embedding, mount the run-status widget:

```ts
import { mountJantraRunWidget } from "@jantra/embed-widget";

await mountJantraRunWidget({
  container: document.querySelector("#jantra-run")!,
  baseUrl: "https://jantra.example.com",
  apiKey: "partner-api-key",
  runId: "run-id",
});
```

API keys map to a server-side `clientId`. Cross-tenant reads are blocked by the
API edge and store queries. Because all public-intake traffic shares one
`clientId`, the Worker edge additionally blocks the tenant-wide list and audit
endpoints so one visitor cannot read another's intake.
