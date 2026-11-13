import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { createLeadBodySchema, parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import { notFound, unauthorized } from "../errors.js";
import { verifyOptionalUser, type VerifiedUser } from "../auth/logtoUser.js";
import { defaultLeadStore, type LeadRecord, type LeadStore } from "../leads/store.js";
import { defaultStore, type ProjectStore } from "../../pipeline/store.js";
import { defaultWebhookStore, type WebhookSubscriptionStore } from "../webhooks/store.js";
import { dispatchWebhookEvent } from "../webhooks/dispatcher.js";

interface LeadRouteDeps {
  clientId: string;
  leadStore?: LeadStore;
  projectStore?: ProjectStore;
  webhookStore?: WebhookSubscriptionStore;
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
  const projectStore = deps.projectStore ?? defaultStore;
  const webhookStore = deps.webhookStore ?? defaultWebhookStore;

  // Capture a lead. Works for anonymous visitors and logged-in users alike; the
  // owning account is taken only from the verified token, never the body.
  app.post("/v1/leads", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(createLeadBodySchema, request.body);
    const user = await resolveUser(request);

    if (body.runId) {
      const project = projectStore.loadProject(clientId, body.runId);
      if (!project) {
        throw notFound(`Run ${body.runId} was not found.`);
      }
    }

    const lead: LeadRecord = {
      id: randomUUID(),
      clientId,
      userSub: user?.sub ?? null,
      name: body.name,
      email: body.email,
      phone: body.phone,
      idea: body.idea,
      source: body.source ?? "jantra-web",
      runId: body.runId,
      createdAt: new Date().toISOString(),
    };

    leadStore.createLead(lead);

    dispatchWebhookEvent(
      {
        clientId,
        type: "lead.created",
        runId: lead.runId,
        payload: {
          leadId: lead.id,
          runId: lead.runId ?? null,
          createdAt: lead.createdAt,
        },
      },
      webhookStore,
    );

    reply.code(201);
    return { id: lead.id, createdAt: lead.createdAt, runId: lead.runId };
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
      runId: lead.runId,
      createdAt: lead.createdAt,
    }));

    return { items };
  });
}
