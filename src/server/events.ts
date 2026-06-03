import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuditEntry } from "../audit.js";
import { config } from "../config.js";

export interface RunEvent {
  id: string;
  cursor: string;
  runId: string;
  ts: string;
  type: string;
  stage?: string;
  message: string;
  data: Record<string, unknown>;
}

type Listener = (event: RunEvent) => void;

let liveSeq = 0;

function eventMessage(entry: AuditEntry): string {
  switch (entry.type) {
    case "model_call":
      return `Model call: ${String(entry.purpose ?? "unknown")}`;
    case "agent_thinking":
      return "Model thinking recorded.";
    case "tool_call":
      return `Tool call: ${String(entry.toolName ?? "unknown")}`;
    case "eval_score":
      return `Eval score: ${String(entry.rubric ?? "unknown")}`;
    case "stage_gate":
      return `Stage gate: ${String(entry.status ?? "unknown")}`;
    case "guardrail_block":
      return "Guardrail blocked the action.";
    default:
      return entry.type;
  }
}

export function auditEntryToRunEvent(entry: AuditEntry, cursor: string): RunEvent {
  const runId =
    typeof entry.projectId === "string" && entry.projectId ? entry.projectId : entry.runId;
  return {
    id: `${entry.runId}:${cursor}`,
    cursor,
    runId,
    ts: entry.ts,
    type: entry.type,
    stage: typeof entry.stage === "string" ? entry.stage : undefined,
    message: eventMessage(entry),
    data: {
      type: entry.type,
      stage: entry.stage,
      purpose: entry.purpose,
      status: entry.status,
      artifactKind: entry.artifactKind,
      costUsd: entry.costUsd,
      usage: entry.usage,
    },
  };
}

export class RunEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publishAuditEntry(entry: AuditEntry): void {
    const runId =
      typeof entry.projectId === "string" && entry.projectId ? entry.projectId : entry.runId;
    this.publish(auditEntryToRunEvent(entry, `live:${++liveSeq}`));
  }

  publish(event: RunEvent): void {
    const listeners = this.listeners.get(event.runId);
    if (!listeners?.size) return;
    for (const listener of listeners) listener(event);
  }

  subscribe(runId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }
}

export const runEventBus = new RunEventBus();

export function readAuditEntries(
  runId: string,
  cursor?: string,
  limit = 100,
): { items: AuditEntry[]; nextCursor?: string } {
  const file = join(config.auditDir, `${runId}.jsonl`);
  if (!existsSync(file)) return { items: [] };
  const start = cursor ? Number(cursor) : 0;
  const safeStart = Number.isInteger(start) && start >= 0 ? start : 0;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const selected = lines.slice(safeStart, safeStart + limit);
  const items = selected.map((line) => JSON.parse(line) as AuditEntry);
  const next = safeStart + selected.length;
  return {
    items,
    nextCursor: next < lines.length ? String(next) : undefined,
  };
}

export function readAuditEvents(
  runId: string,
  cursor?: string,
  limit = 100,
): { items: RunEvent[]; nextCursor?: string } {
  const page = readAuditEntries(runId, cursor, limit);
  const start = cursor ? Number(cursor) || 0 : 0;
  return {
    items: page.items.map((entry, index) => auditEntryToRunEvent(entry, String(start + index + 1))),
    nextCursor: page.nextCursor,
  };
}
