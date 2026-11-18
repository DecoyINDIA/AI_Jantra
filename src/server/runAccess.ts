import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

import type { Project } from "../pipeline/types.js";
import { notFound } from "./errors.js";

/**
 * Public runs are bound to the browser session that created them. Run IDs are
 * random, but they travel through logs, lead records, webhooks and support
 * tickets; on their own they should not let anyone read or drive a visitor's
 * intake. Creation returns a one-time `runToken`; only its hash is stored.
 * Full-scope (operator) keys are not subject to this check.
 */
export const RUN_TOKEN_HEADER = "x-jantra-run-token";

function hashRunToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueRunAccessToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRunToken(token) };
}

export function assertRunTokenAccess(request: FastifyRequest, project: Project): void {
  if (request.identity?.scope !== "public") return;
  const header = request.headers[RUN_TOKEN_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  const expected = project.visitorTokenHash;
  const ok =
    typeof presented === "string" &&
    presented.length > 0 &&
    presented.length <= 128 &&
    typeof expected === "string" &&
    timingSafeEqual(Buffer.from(hashRunToken(presented), "hex"), Buffer.from(expected, "hex"));
  // Same response as a missing run, so the check is not an existence oracle.
  if (!ok) throw notFound(`Run ${project.id} was not found.`);
}
