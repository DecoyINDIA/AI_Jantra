import type { Project } from "../pipeline/types.js";

/**
 * A gate transition worth notifying an operator about: the run has stopped and
 * is now waiting on a human (either to answer a question or to confirm a stage
 * at the gate). The server wires a publisher that fans these out to registered
 * webhooks; the orchestrator stays free of any server/transport dependency,
 * mirroring `setAuditPublisher`.
 */
export interface GateEvent {
  type: "run.awaiting_confirmation" | "run.awaiting_input";
  clientId: string;
  runId: string;
  stageId: string;
  interactionId?: string;
}

type GatePublisher = (event: GateEvent) => void;

let publisher: GatePublisher | null = null;

export function setGatePublisher(next: GatePublisher | null): void {
  publisher = next;
}

export function publishGateEvent(event: GateEvent): void {
  if (!publisher) return;
  try {
    publisher(event);
  } catch {
    // Notification is best-effort and must never break the run loop.
  }
}

export function gateEventForStatus(
  project: Project,
  stageId: string,
  status: "awaiting_confirmation" | "awaiting_input",
  interactionId?: string,
): GateEvent {
  return {
    type: status === "awaiting_input" ? "run.awaiting_input" : "run.awaiting_confirmation",
    clientId: project.clientId,
    runId: project.id,
    stageId,
    interactionId,
  };
}
