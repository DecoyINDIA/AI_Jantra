import type { FastifyReply } from "fastify";

import {
  CostCeilingExceededError,
  GateConflictError,
  StageFailedClosedError,
} from "../runtime/errors.js";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, "not_found", message);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function unauthorized(message: string): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function conflict(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(409, code, message, details);
}

export function sendHttpError(reply: FastifyReply, err: unknown, requestId?: string): void {
  if (err instanceof CostCeilingExceededError) {
    reply.status(429).send({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }
  if (err instanceof GateConflictError) {
    reply.status(409).send({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    reply.status(err.statusCode).send({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }
  if (err instanceof StageFailedClosedError) {
    reply.status(422).send({
      error: {
        code: "stage_failed_closed",
        message: "The stage stopped because its output could not be verified.",
        details: { requestId },
      },
    });
    return;
  }
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    reply.status(statusCode).send({
      error: {
        code: "bad_request",
        message: "Request could not be processed.",
      },
    });
    return;
  }
  reply.status(500).send({
    error: {
      code: "internal_error",
      message: "Internal error.",
      details: { requestId },
    },
  });
}
