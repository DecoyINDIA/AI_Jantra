import "dotenv/config";

/**
 * Central config. Read once at startup. Nothing here is interpolated into a
 * system prompt, so changing it never breaks prompt caching.
 */
export const config = {
  /** ALWAYS the latest Opus unless explicitly overridden. */
  model: process.env.MAINFRAME_MODEL ?? "claude-opus-4-8",
  /** low | medium | high | xhigh | max — high is the right default for agentic work. */
  effort: (process.env.MAINFRAME_EFFORT ?? "high") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",
  /** Where the audit trail (one JSONL file per run) is written. */
  auditDir: process.env.MAINFRAME_AUDIT_DIR ?? ".mainframe/audit",
  /** Hard ceiling on agentic steps, so a misbehaving agent can't loop forever. */
  maxSteps: 16,
  /** Per-turn output cap. 16000 stays under the SDK's non-streaming HTTP timeout. */
  maxTokens: 16000,
};

export function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
}
