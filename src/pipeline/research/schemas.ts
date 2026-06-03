import { z } from "zod";

export const researchPlanSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(3),
        question: z.string().min(10),
        searchQueries: z.array(z.string().min(5)).min(2).max(4),
      }),
    )
    .min(4)
    .max(8),
});

export type ResearchPlan = z.infer<typeof researchPlanSchema>;

export const sectionClaimsSchema = z.object({
  summary: z.string().min(20),
  claims: z.array(
    z.object({
      text: z.string().min(10),
      citations: z
        .array(
          z.object({
            sourceId: z.string().min(1),
            quote: z.string().trim().min(1),
          }),
        )
        .min(1),
    }),
  ),
  risks: z.array(z.string()).default([]),
});

export type SectionClaims = z.infer<typeof sectionClaimsSchema>;

export const researchCritiqueSchema = z.object({
  scores: z.object({
    factualAccuracy: z.number().min(1).max(5),
    citationAccuracy: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
    sourceQuality: z.number().min(1).max(5),
    balance: z.number().min(1).max(5),
  }),
  passed: z.boolean(),
  notes: z.string(),
});

export type ResearchCritique = z.infer<typeof researchCritiqueSchema>;
