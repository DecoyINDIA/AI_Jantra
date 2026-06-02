# Jantra AI — agent runtime

Jantra AI builds autonomous agents that run the parts of a business no one wants to babysit. This repo is the **product**, not the marketing site: a reusable TypeScript runtime for those agents, plus the first reference agent (customer support) built on it.

The thesis is a studio one: **one engine, many agents.** The runtime handles the hard, shared parts — the agentic loop, a guardrail gate, a full audit trail, and human handoff. Each vertical (support, revenue, operations, custom) is just a different prompt and tool set on top.

## What's here

```
src/
  agent.ts              the runtime: manual agentic loop on Claude
  policy.ts             guardrail gate (allow / ask / deny per tool)
  audit.ts              append-only JSONL trail — every action + reasoning
  handoff.ts            human handoff sink
  config.ts             model, effort, limits (env-overridable)
  types.ts              core domain types
  tools/escalate.ts     built-in "hand off to a human" tool (every agent gets it)
  agents/support/       the reference agent: prompt + tools + a seeded backend
  cli.ts                runnable demo
```

### Design choices

- **Manual loop, not the SDK tool runner.** Every action must pass the policy gate, be logged with its reasoning, and be interruptible for human approval. That needs a hand-written loop.
- **Audit everything.** The brand promise is "you can see everything it did, and why." Thinking, messages, tool calls, policy decisions, approvals, results, and handoffs are all written to `.jantra/audit/<run>.jsonl`.
- **Fail closed.** Sensitive and write actions require approval by default; with no interactive terminal and no `--auto-approve`, they are denied, not silently run.
- **Prompt cache stays warm.** The system prompt is frozen (no dates or per-request values) and the tool order is stable, so repeated turns hit the cache. Watch `cache read` in the run summary.
- **Latest Claude.** Defaults to `claude-opus-4-8` with adaptive thinking at `high` effort.

## Run it

```bash
npm install
cp .env.example .env          # add your ANTHROPIC_API_KEY
npm run support               # interactive approvals on the terminal
npm run support:auto          # auto-approve gated actions (demo only)
npm run support -- "Where is order A-1002? email dana@example.com"
```

The default scenario asks for a refund on a damaged item. Watch the agent look up the order, check the refund policy, ask you to approve the refund (a sensitive action), send the reply, and write the whole trace to the audit file.

Try a handoff path: ask for something out of policy (e.g. a refund on a months-old order) and watch it escalate instead of guessing.

## Status

MVP / pre-product. Numbers and the seeded backend are placeholders. The next steps toward a real venture are real integrations (helpdesk, order system) behind the existing tool surface, multi-turn conversations, and an approval/handoff UI in place of the terminal prompt.
