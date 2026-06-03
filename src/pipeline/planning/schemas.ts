import { z } from "zod";

const requirementIdSchema = z.string().regex(/^req-\d+$/);

export const planningRequirementSchema = z.object({
  id: requirementIdSchema,
  text: z.string().min(10),
  acceptanceCriteria: z.array(z.string().min(5)).min(1),
});

export const planningDocumentSchema = z.object({
  title: z.string().min(3),
  requirements: z.array(planningRequirementSchema).default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3),
        body: z.string().min(20),
        sourceIds: z.array(z.string()).default([]),
        requirementIds: z.array(requirementIdSchema).default([]),
      }),
    )
    .min(5),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type PlanningDocument = z.infer<typeof planningDocumentSchema>;

export const planningCritiqueSchema = z.object({
  scores: z.object({
    completeness: z.number().min(1).max(5),
    internalConsistency: z.number().min(1).max(5),
    grounding: z.number().min(1).max(5),
    technicalSoundness: z.number().min(1).max(5),
    actionability: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
});

export type PlanningCritique = z.infer<typeof planningCritiqueSchema>;
