import type { Policy, PolicyVerdict, Risk, ToolDef } from "./types.js";

export interface PolicyConfig {
  /** Decision applied per risk class. */
  byRisk: Record<Risk, PolicyVerdict["decision"]>;
  /** Tool names that are always denied, whatever their risk class. */
  denyTools?: string[];
  /** Tool names that always require human sign-off. */
  alwaysAsk?: string[];
}

/**
 * Sensible default: reads run freely, writes and sensitive actions ask first.
 * A real deployment tightens this per customer — that config is the contract
 * for what an agent is allowed to touch before it touches anything.
 */
export const defaultPolicyConfig: PolicyConfig = {
  byRisk: { read: "allow", write: "ask", sensitive: "ask" },
};

export class RuleBasedPolicy implements Policy {
  constructor(private readonly cfg: PolicyConfig = defaultPolicyConfig) {}

  decide(tool: ToolDef): PolicyVerdict {
    if (this.cfg.denyTools?.includes(tool.name)) {
      return { decision: "deny", reason: `Tool "${tool.name}" is on the deny list.` };
    }
    if (this.cfg.alwaysAsk?.includes(tool.name)) {
      return {
        decision: "ask",
        reason: `Tool "${tool.name}" always requires human approval.`,
      };
    }
    const decision = this.cfg.byRisk[tool.risk];
    return {
      decision,
      reason: `Risk class "${tool.risk}" maps to "${decision}".`,
    };
  }
}
