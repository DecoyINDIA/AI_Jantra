import type { DataSnapshot } from "../schema.js";

export interface ConnectorConfig {
  clientId: string;
  config: Record<string, any>;
  credentials?: Record<string, string>;
}

export interface OpsConnector {
  id: string;
  fetch(cfg: ConnectorConfig): Promise<Partial<DataSnapshot>>;
}
