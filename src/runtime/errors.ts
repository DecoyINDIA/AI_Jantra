export class JantraError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ModelProviderError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "model_provider_error", details);
  }
}

export class SchemaValidationError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "schema_validation_error", details);
  }
}

export class GuardrailBlockedError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "guardrail_blocked", details);
  }
}

export class CostCeilingExceededError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "cost_ceiling_exceeded", details);
  }
}

export class StageFailedClosedError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "stage_failed_closed", details);
  }
}

/**
 * Raised when a gate transition is requested against a stage whose status does
 * not permit it (e.g. confirming a stage that never reached the gate, or
 * advancing a stage that is already awaiting confirmation). Maps to HTTP 409 so
 * the human gate is enforced server-side, not just in the UI.
 */
export class GateConflictError extends JantraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "gate_conflict", details);
  }
}
