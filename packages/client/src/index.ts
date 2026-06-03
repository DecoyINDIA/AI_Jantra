export interface JantraClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class JantraClient {
  constructor(private readonly options: JantraClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.options.apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as T;
  }

  listAgents(): Promise<unknown> {
    return this.request("/v1/agents");
  }

  createRun(agentId: string, title: string, input?: string): Promise<unknown> {
    return this.request("/v1/runs", {
      method: "POST",
      body: JSON.stringify({ agentId, title, input }),
    });
  }

  getRun(runId: string): Promise<unknown> {
    return this.request(`/v1/runs/${runId}`);
  }

  advanceRun(runId: string): Promise<unknown> {
    return this.request(`/v1/runs/${runId}/advance`, { method: "POST" });
  }

  answerInteraction(
    runId: string,
    interactionId: string,
    body: { text?: string; approved?: boolean },
  ): Promise<unknown> {
    return this.request(`/v1/runs/${runId}/interactions/${interactionId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
