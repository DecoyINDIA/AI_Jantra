# Agent Factory

This folder is the standard for creating agents on the Jantra runtime. Any builder, human or AI, who needs to create, modify, or review an agent starts here. Read these documents in order:

1. **[AGENT_CREATION_SOP.md](AGENT_CREATION_SOP.md)** - the step-by-step standard operating procedure for building a new agent. Follow it top to bottom; every step exists because skipping it has a known failure mode.
2. **[AGENT_QUALITY_PLAYBOOK.md](AGENT_QUALITY_PLAYBOOK.md)** - what separates a world-class agent from a working one. Best practices, anti-patterns, and the quality bar every Jantra agent must meet.
3. **[AGENT_BUILDER_PLAN.md](AGENT_BUILDER_PLAN.md)** - the plan for the meta-agent (the agent that builds other agents). Status: planned, not implemented.

## What "an agent" means here

On this runtime an agent is not a free-running loop. It is:

- A declarative **`AgentDefinition`** (`src/agents/definition.ts`): id, name, description, version, and an ordered list of stages. Each stage declares its kind, runner, model tier, artifact kinds, gate, and interaction mode.
- One **`StageRunner`** per stage (`src/agents/runners.ts`): the imperative implementation that talks to the model provider, runs the generator/critic loop, and returns artifacts.
- A registration in the **`AgentRegistry`** (`src/agents/registry.ts`), which validates and snapshots the definition.

The orchestrator (`src/pipeline/orchestrator.ts`) owns everything between stages: gates, autonomy, run locks, resume, audit, and cost rollups. Runners own everything inside a stage. Keep that boundary sharp.

## Non-negotiables (inherited from AGENTS.md, restated for agent authors)

- All model calls go through the provider interface. No stage imports a vendor SDK.
- Generator and critic are separate passes. No stage accepts its own first draft.
- Ground or abstain. No stated fact without a verifiable source.
- Fail closed, with context. Never ship a weak artifact silently.
- Everything auditable: model calls, tokens, cost, tools, gates, guardrails, evals, handoffs.
- Human gate is the default. Autonomy is earned per stage by passing evals under cost ceilings.
- Validate every structured output with a schema. Never trust raw model JSON.
- Secrets never appear in prompts, logs, or artifacts. Every record carries `clientId`.
