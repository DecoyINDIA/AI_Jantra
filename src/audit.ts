import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";

/**
 * The audit trail is the product's core promise: "you can see everything it did,
 * and why." Every model turn, tool call, policy decision, approval, and handoff
 * is appended as one JSON line, with a timestamp and the run id. Append-only,
 * synchronous on purpose. We never want to lose an entry to a crash.
 */
export type AuditType =
  | "run_created"
  | "run_start"
  | "run_end"
  | "interaction"
  | "agent_thinking"
  | "agent_message"
  | "tool_call"
  | "policy_decision"
  | "approval"
  | "tool_result"
  | "handoff"
  | "model_call"
  | "model_usage"
  | "eval_score"
  | "citation_verified"
  | "citation_rejected"
  | "guardrail_block"
  | "stage_gate"
  | "cost_rollup"
  | "cost_ceiling_exceeded"
  | "source_registered"
  | "source_cap_applied"
  | "key_created"
  | "key_revoked"
  | "resume"
  | "gateway_completion"
  | "gateway_cost_exceeded"
  | "error";

export interface AuditEntry {
  ts: string;
  runId: string;
  type: AuditType;
  clientId?: string;
  [key: string]: unknown;
}

export type AuditPublisher = (entry: AuditEntry) => void;

let auditPublisher: AuditPublisher | null = null;

export function setAuditPublisher(publisher: AuditPublisher | null): void {
  auditPublisher = publisher;
}

const LARGE_FIELD_KEYS = new Set(["input", "content", "data", "text"]);
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateString(value: string, maxBytes: number): string {
  const bytes = byteLength(value);
  if (bytes <= maxBytes) return value;
  let marker = `...[truncated ${bytes} bytes]`;
  let prefixBytes = Math.max(0, maxBytes - byteLength(marker));
  let prefix = Buffer.from(value, "utf8").subarray(0, prefixBytes).toString("utf8");
  marker = `...[truncated ${bytes - byteLength(prefix)} bytes]`;
  prefixBytes = Math.max(0, maxBytes - byteLength(marker));
  prefix = Buffer.from(value, "utf8").subarray(0, prefixBytes).toString("utf8");
  return `${prefix}${marker}`;
}

function truncateLargeField(value: unknown): unknown {
  const maxBytes = config.auditMaxFieldBytes;
  if (maxBytes <= 0) return value;
  if (typeof value === "string") return truncateString(value, maxBytes);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || byteLength(serialized) <= maxBytes) return value;
  return truncateString(serialized, maxBytes);
}

function sanitizeAuditData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      LARGE_FIELD_KEYS.has(key) ? truncateLargeField(value) : value,
    ]),
  );
}

export function redactToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[redacted]" : value,
    ]),
  );
}

export class AuditLogger {
  private readonly file: string;
  readonly entries: AuditEntry[] = [];

  constructor(
    readonly runId: string,
    dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${runId}.jsonl`);
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    const safeData = sanitizeAuditData(data);
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      ...safeData,
    };
    this.entries.push(entry);
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
    auditPublisher?.(entry);
  }

  get path(): string {
    return this.file;
  }
}
