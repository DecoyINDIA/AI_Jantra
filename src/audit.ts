import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The audit trail is the product's core promise: "you can see everything it did,
 * and why." Every model turn, tool call, policy decision, approval, and handoff
 * is appended as one JSON line, with a timestamp and the run id. Append-only,
 * synchronous on purpose — we never want to lose an entry to a crash.
 */
export type AuditType =
  | "run_start"
  | "run_end"
  | "agent_thinking"
  | "agent_message"
  | "tool_call"
  | "policy_decision"
  | "approval"
  | "tool_result"
  | "handoff"
  | "model_usage"
  | "error";

export interface AuditEntry {
  ts: string;
  runId: string;
  type: AuditType;
  [key: string]: unknown;
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
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      ...data,
    };
    this.entries.push(entry);
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
  }

  get path(): string {
    return this.file;
  }
}
