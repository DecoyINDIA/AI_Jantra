import { z } from "zod";

import { config } from "../config.js";
import { resolveCatalog } from "../model/catalog.js";
import { HttpError } from "./errors.js";

export const RUN_ID_MAX_CHARS = 96;
export const AGENT_ID_MAX_CHARS = 96;
export const RUN_TITLE_MAX_CHARS = 200;
export const PUBLIC_INPUT_MAX_CHARS = 4000;
export const REJECT_REASON_MAX_CHARS = 2000;
export const CURSOR_MAX_CHARS = 512;
export const API_KEY_LABEL_MAX_CHARS = 120;
export const API_KEY_CLIENT_ID_MAX_CHARS = 96;
export const API_KEY_SUBJECT_MAX_CHARS = 160;
export const EFFECTIVE_PUBLIC_INPUT_MAX_CHARS = Math.min(
  PUBLIC_INPUT_MAX_CHARS,
  config.maxUserMessageChars,
);

export const agentParamsSchema = z.object({
  agentId: z.string().min(1).max(AGENT_ID_MAX_CHARS),
});

export const runParamsSchema = z.object({
  runId: z.string().min(1).max(RUN_ID_MAX_CHARS),
});

export const artifactParamsSchema = runParamsSchema.extend({
  artifactId: z.string().min(1).max(160),
});

export const MODEL_ID_MAX_CHARS = 96;

export const createRunBodySchema = z.object({
  agentId: z.string().min(1).max(AGENT_ID_MAX_CHARS).default("planning-pipeline"),
  title: z.string().min(1).max(RUN_TITLE_MAX_CHARS).default("Untitled run"),
  input: z.string().max(EFFECTIVE_PUBLIC_INPUT_MAX_CHARS).optional(),
  // Optional run-level model pin, validated against the server-side catalog.
  // Omitted → the env-configured default model is used.
  modelId: z
    .string()
    .max(MODEL_ID_MAX_CHARS)
    .refine((id) => Boolean(resolveCatalog(id)), {
      message: "modelId is not in the model catalog.",
    })
    .optional(),
  // Run-level autonomy policy. "gated" (default) stops at every human gate;
  // "auto" auto-confirms gates that pass their eval and cost guardrails.
  autonomy: z.enum(["gated", "auto"]).optional(),
});

export const completeBodySchema = z.object({
  system: z.string().max(EFFECTIVE_PUBLIC_INPUT_MAX_CHARS),
  user: z.string().max(EFFECTIVE_PUBLIC_INPUT_MAX_CHARS),
  responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
  modelId: z
    .string()
    .max(MODEL_ID_MAX_CHARS)
    .refine((id) => Boolean(resolveCatalog(id)), {
      message: "modelId is not in the model catalog.",
    })
    .optional(),
  maxOutputTokens: z.number().int().positive().max(2000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  purpose: z.string().max(120).optional(),
});

export const listRunsQuerySchema = z.object({
  agentId: z.string().max(AGENT_ID_MAX_CHARS).optional(),
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  currentStage: z.string().max(64).optional(),
  cursor: z.string().max(CURSOR_MAX_CHARS).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const rejectRunBodySchema = z.object({
  reason: z.string().min(1).max(REJECT_REASON_MAX_CHARS),
});

export const cursorQuerySchema = z.object({
  cursor: z.string().max(CURSOR_MAX_CHARS).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const adminApiKeyParamsSchema = z.object({
  id: z.string().min(1).max(96),
});

export const createAdminApiKeyBodySchema = z.object({
  label: z.string().trim().min(1).max(API_KEY_LABEL_MAX_CHARS),
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(API_KEY_CLIENT_ID_MAX_CHARS)
    .regex(/^[A-Za-z0-9_.:-]+$/, "clientId must use slug-safe characters."),
  subject: z.string().trim().min(1).max(API_KEY_SUBJECT_MAX_CHARS),
});

export const listAdminApiKeysQuerySchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(API_KEY_CLIENT_ID_MAX_CHARS)
    .regex(/^[A-Za-z0-9_.:-]+$/, "clientId must use slug-safe characters.")
    .optional(),
  includeRevoked: z.coerce.boolean().optional(),
});

export const LEAD_NAME_MAX_CHARS = 200;
export const LEAD_EMAIL_MAX_CHARS = 320;
export const LEAD_PHONE_MAX_CHARS = 32;
export const LEAD_IDEA_MAX_CHARS = 4000;
export const LEAD_SOURCE_MAX_CHARS = 64;

// Public lead-capture payload. Posted by the marketing site's lead form, both
// for anonymous visitors and logged-in users (identity is verified separately
// from the Logto token, never trusted from the body).
export const createLeadBodySchema = z.object({
  name: z.string().trim().min(1).max(LEAD_NAME_MAX_CHARS),
  email: z.string().trim().toLowerCase().email().max(LEAD_EMAIL_MAX_CHARS),
  phone: z.string().trim().max(LEAD_PHONE_MAX_CHARS).optional(),
  idea: z.string().trim().min(1).max(LEAD_IDEA_MAX_CHARS),
  source: z.string().trim().max(LEAD_SOURCE_MAX_CHARS).optional(),
});

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "bad_request", "Request validation failed.", parsed.error.issues);
  }
  return parsed.data;
}
