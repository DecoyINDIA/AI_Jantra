import { randomUUID } from "node:crypto";

import type {
  InteractionResponse,
  PendingInteraction,
  Project,
} from "../pipeline/types.js";

export function createQuestionInteraction(
  project: Project,
  stageId: string,
  prompt: string,
): PendingInteraction {
  return {
    id: randomUUID(),
    runId: project.id,
    stageId,
    kind: "question",
    prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export function createApprovalInteraction(
  project: Project,
  stageId: string,
  prompt: string,
  toolName: string,
  input: unknown,
): PendingInteraction {
  return {
    id: randomUUID(),
    runId: project.id,
    stageId,
    kind: "approval",
    prompt,
    toolName,
    input,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export function upsertPendingInteraction(
  project: Project,
  interaction: PendingInteraction,
): PendingInteraction {
  const existing = project.interactions.find((candidate) => candidate.id === interaction.id);
  if (existing) return existing;
  project.interactions.push(interaction);
  return interaction;
}

export function pendingInteraction(
  project: Project,
  interactionId: string | undefined,
): PendingInteraction | null {
  if (!interactionId) return null;
  return (
    project.interactions.find(
      (interaction) =>
        interaction.id === interactionId && interaction.status === "pending",
    ) ?? null
  );
}

export function resolvePendingInteraction(
  project: Project,
  response: InteractionResponse,
): PendingInteraction {
  const interaction = pendingInteraction(project, response.interactionId);
  if (!interaction) {
    throw new Error(`Pending interaction ${response.interactionId} was not found.`);
  }
  interaction.status = "answered";
  interaction.answeredAt = new Date().toISOString();
  interaction.response = response;
  return interaction;
}
