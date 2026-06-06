import { z } from "zod";

/**
 * The five evidence sections every research run must cover with web search
 * (brief 6.1). Founder-Anchor Fit is the sixth required section but is
 * interpretive: it is synthesized from these sections plus the founder anchors
 * rather than from its own searches, so it has no query plan.
 */
export const EVIDENCE_SECTION_KEYS = [
  "market_demand",
  "competitive_landscape",
  "viability_assessment",
  "regulatory_legal",
  "technical_feasibility",
] as const;

export type EvidenceSectionKey = (typeof EVIDENCE_SECTION_KEYS)[number];

const queryList = z.array(z.string().min(5)).min(2).max(4);

export const researchPlanSchema = z.object({
  market_demand: queryList,
  competitive_landscape: queryList,
  viability_assessment: queryList,
  regulatory_legal: queryList,
  technical_feasibility: queryList,
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

/**
 * Founder-Anchor Fit (brief 6.1): an interpretive read of how the gathered
 * market evidence aligns with the founder's stated build_philosophy and
 * founder_philosophy. It asserts no new market facts, so it carries no
 * citations - only alignment observations and tensions.
 */
export const founderAnchorSchema = z.object({
  summary: z.string().min(20),
  alignmentPoints: z.array(z.string().min(8)).default([]),
  tensions: z.array(z.string().min(8)).default([]),
});

export type FounderAnchorFit = z.infer<typeof founderAnchorSchema>;

/**
 * Viability Summary surfaced at the human gate (brief 6.2). Neutral framing:
 * red flags, opportunities, and an economic-sustainability note, with no
 * go/no-go recommendation.
 */
export const viabilitySummarySchema = z.object({
  redFlags: z.array(z.string().min(8)).default([]),
  opportunities: z.array(z.string().min(8)).default([]),
  economicsNote: z.string().min(20),
});

export type ViabilitySummary = z.infer<typeof viabilitySummarySchema>;

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
