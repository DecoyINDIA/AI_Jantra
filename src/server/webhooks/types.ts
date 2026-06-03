export interface WebhookSubscription {
  id: string;
  clientId: string;
  url: string;
  secret?: string;
  events: string[];
  createdAt: string;
}

export interface WebhookEvent {
  id: string;
  clientId: string;
  type: string;
  runId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}
