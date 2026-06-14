import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { createLeadBodySchema, parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import { unauthorized } from "../errors.js";
import { verifyOptionalUser, type VerifiedUser } from "../auth/logtoUser.js";
import { defaultLeadStore, type LeadRecord, type LeadStore } from "../leads/store.js";

interface LeadRouteDeps {
  clientId: string;
  leadStore?: LeadStore;
}

async function resolveUser(request: Parameters<typeof verifyOptionalUser>[0]): Promise<VerifiedUser | null> {
  try {
    return await verifyOptionalUser(request);
  } catch {
    // A token was supplied but failed verification (expired, wrong audience,
    // bad signature). That is a client error, not an anonymous request.
    throw unauthorized("Invalid user token.");
  }
}

export function registerLeadRoutes(app: FastifyInstance, deps: LeadRouteDeps): void {
  const leadStore = deps.leadStore ?? defaultLeadStore;

  // Capture a lead. Works for anonymous visitors and logged-in users alike; the
  // owning account is taken only from the verified token, never the body.
  app.post("/v1/leads", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createLeadBodySchema, request.body);
    const user = await resolveUser(request);

    const lead: LeadRecord = {
      id: randomUUID(),
      clientId,
      userSub: user?.sub ?? null,
      name: body.name,
      email: body.email,
      phone: body.phone,
      idea: body.idea,
      source: body.source ?? "jantra-web",
      createdAt: new Date().toISOString(),
    };

    leadStore.createLead(lead);

    reply.code(201);
    return { id: lead.id, createdAt: lead.createdAt };
  });

  // List the calling user's own leads for the account section. Requires a valid
  // user token — anonymous callers get nothing they could correlate to a person.
  app.get("/v1/leads", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const user = await resolveUser(request);
    if (!user) {
      throw unauthorized("A user token is required to list leads.");
    }

    const items = leadStore.listLeadsByUser(clientId, user.sub).map((lead) => ({
      id: lead.id,
      name: lead.name,
      email: lead.email,
      idea: lead.idea,
      source: lead.source,
      createdAt: lead.createdAt,
    }));

    return { items };
  });
}
