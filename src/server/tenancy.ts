import type { FastifyRequest } from "fastify";

import type { Project } from "../pipeline/types.js";
import { forbidden } from "./errors.js";

export interface Identity {
  subject: string;
  clientId: string;
  mode: "local" | "remote";
}

declare module "fastify" {
  interface FastifyRequest {
    identity?: Identity;
  }
}

export function requestClientId(request: FastifyRequest, fallback: string): string {
  return request.identity?.clientId ?? fallback;
}

export function assertProjectAccess(identity: Identity | undefined, project: Project): void {
  if (identity && identity.clientId !== project.clientId) {
    throw forbidden("Run does not belong to this tenant.");
  }
}
