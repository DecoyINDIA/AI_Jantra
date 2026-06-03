import { z } from "zod";

export const agentParamsSchema = z.object({
  agentId: z.string().min(1),
});

export const runParamsSchema = z.object({
  runId: z.string().min(1),
});

export const artifactParamsSchema = runParamsSchema.extend({
  artifactId: z.string().min(1),
});

export const createRunBodySchema = z.object({
  agentId: z.string().min(1).default("planning-pipeline"),
  title: z.string().min(1).default("Untitled run"),
  input: z.string().optional(),
});

export const listRunsQuerySchema = z.object({
  agentId: z.string().optional(),
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  currentStage: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const rejectRunBodySchema = z.object({
  reason: z.string().min(1),
});

export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
