export interface EvalFixture {
  id: string;
  idea: string;
  expected: {
    users: string[];
    features: string[];
    risks: string[];
  };
}

export const fixtures: EvalFixture[] = [
  {
    id: "ops-reconciliation",
    idea:
      "A tool for small finance teams that reconciles Shopify orders, Stripe payments, and QuickBooks invoices every morning, flags mismatches, and prepares an approval-ready summary.",
    expected: {
      users: ["finance", "operations"],
      features: ["reconciliation", "mismatch detection", "approval summary"],
      risks: ["data quality", "accounting integration"],
    },
  },
  {
    id: "clinic-intake",
    idea:
      "A patient intake assistant for small clinics that collects forms before appointments, checks insurance details, and hands uncertain cases to the front desk.",
    expected: {
      users: ["clinic", "front desk"],
      features: ["forms", "insurance", "handoff"],
      risks: ["privacy", "verification"],
    },
  },
];
