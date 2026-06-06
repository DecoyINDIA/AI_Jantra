import { z } from "zod";

const requirementIdSchema = z.string().regex(/^req-\d+$/);

export const planningRequirementSchema = z.object({
  id: requirementIdSchema,
  text: z.string().min(10).max(500),
  acceptanceCriteria: z.array(z.string().min(5).max(300)).min(1).max(5),
});

export const planningDocumentSchema = z.object({
  title: z.string().min(3).max(140),
  requirements: z.array(planningRequirementSchema).max(12).default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3).max(120),
        body: z.string().min(20).max(1600),
        sourceIds: z.array(z.string()).max(10).default([]),
        requirementIds: z.array(requirementIdSchema).max(12).default([]),
      }),
    )
    .min(5)
    .max(10),
  risks: z.array(z.string().max(400)).max(10).default([]),
  openQuestions: z.array(z.string().max(400)).max(10).default([]),
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
  notes: z.string().max(900),
});

export type PlanningCritique = z.infer<typeof planningCritiqueSchema>;
