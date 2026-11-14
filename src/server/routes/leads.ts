import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { createLeadBodySchema, parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { verifyOptionalUser, type VerifiedUser } from "../auth/logtoUser.js";
import {
  defaultLeadStore,
  JsonLeadStore,
  SqliteLeadStore,
  type LeadRecord,
  type LeadStore,
} from "../leads/store.js";
import { defaultStore, type ProjectStore } from "../../pipeline/store.js";
import { defaultWebhookStore, type WebhookSubscriptionStore } from "../webhooks/store.js";
import { dispatchWebhookEvent } from "../webhooks/dispatcher.js";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";

const leadParamsSchema = z.object({
  id: z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/, "id must use slug-safe characters."),
});

export interface LeadRouteDeps {
  clientId: string;
  leadStore?: LeadStore;
  projectStore?: ProjectStore;
  webhookStore?: WebhookSubscriptionStore;
  sweepIntervalMs?: number;
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

  if (config.enableLeadDeletionSweep && typeof leadStore.sweepExpiredLeads === "function") {
    const sweepIntervalMs = deps.sweepIntervalMs ?? 24 * 60 * 60 * 1000;
    const sweepTimer = setInterval(() => {
      try {
        leadStore.sweepExpiredLeads?.(config.leadRetentionDays, {
          deleteLinkedRuns: config.leadDeleteLinkedRuns,
          projectStore,
        });
      } catch (err) {
        console.warn("Daily lead retention sweep failed:", err);
      }
    }, sweepIntervalMs);

    if (typeof sweepTimer.unref === "function") {
      sweepTimer.unref();
    }

    app.addHook("onClose", async () => {
      clearInterval(sweepTimer);
    });
  }

  // Trigger a lead retention sweep on demand. Full-scope callers only.
  // Gated by JANTRA_ENABLE_LEAD_DELETION_SWEEP.
  app.post("/v1/leads/sweep", async (request) => {
    const identity = request.identity;
    if (identity?.scope !== "full") {
      throw forbidden("Full scope is required to trigger lead retention sweep.");
    }
    if (!config.enableLeadDeletionSweep) {
      throw forbidden("Lead deletion sweep is disabled by configuration.");
    }
    if (typeof leadStore.sweepExpiredLeads !== "function") {
      return { status: "ok", sweptLeads: 0 };
    }
    const swept = leadStore.sweepExpiredLeads(config.leadRetentionDays, {
      deleteLinkedRuns: config.leadDeleteLinkedRuns,
      projectStore,
    });
    return { status: "ok", sweptLeads: swept, retentionDays: config.leadRetentionDays };
  });

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

  // List leads. Full-scope callers (operators / local mode) receive all leads for
  // the client tenant. Public callers require a valid user token and only see their
  // own leads. Anonymous callers get nothing.
  app.get("/v1/leads", async (request) => {
    const clientId = requestClientId(request, deps.clientId);
    const identity = request.identity;

    if (identity?.scope === "full") {
      const items = leadStore.listLeads(clientId).map((lead) => ({
        id: lead.id,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        idea: lead.idea,
        source: lead.source,
        runId: lead.runId,
        createdAt: lead.createdAt,
      }));
      return { items };
    }

    const user = await resolveUser(request);
    if (!user) {
      throw unauthorized("A user token is required to list leads.");
    }

    const items = leadStore.listLeadsByUser(clientId, user.sub).map((lead) => ({
      id: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      idea: lead.idea,
      source: lead.source,
      runId: lead.runId,
      createdAt: lead.createdAt,
    }));

    return { items };
  });

  // Delete a lead. Full-scope callers can delete any lead in the client tenant.
  // Public callers require a valid user token matching the lead's owner.
  // Deletion is audited with IDs only.
  app.delete("/v1/leads/:id", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const params = parseWith(leadParamsSchema, request.params);
    const query = request.query as Record<string, string | undefined> | undefined;
    const identity = request.identity;

    const existing = leadStore.getLead?.(clientId, params.id);
    if (!existing) {
      throw notFound(`Lead ${params.id} was not found.`);
    }

    if (identity?.scope !== "full") {
      const user = await resolveUser(request);
      if (!user || existing.userSub !== user.sub) {
        throw forbidden("You are not authorized to delete this lead.");
      }
    }

    const deleteLinkedRun =
      query?.deleteLinkedRun === "true" ||
      query?.deleteLinkedRun === "1" ||
      query?.deleteRun === "true" ||
      query?.deleteRun === "1" ||
      config.leadDeleteLinkedRuns;

    const deleted = leadStore.deleteLead?.(clientId, params.id, {
      deleteLinkedRun,
      projectStore,
    }) ?? false;
    if (!deleted) {
      throw notFound(`Lead ${params.id} was not found.`);
    }

    // Explicit tenant-scoped linked run cleanup if not handled by store
    if (deleteLinkedRun && existing.runId) {
      const existingProject = projectStore.loadProject(clientId, existing.runId);
      if (existingProject && existingProject.clientId === clientId) {
        projectStore.deleteProject?.(clientId, existing.runId);
        const auditFile = join(config.auditDir, `${existing.runId}.jsonl`);
        if (existsSync(auditFile)) {
          try {
            rmSync(auditFile, { force: true });
          } catch {}
        }
      }
    }

    if (!(leadStore instanceof SqliteLeadStore || leadStore instanceof JsonLeadStore)) {
      const audit = new AuditLogger("system", config.auditDir);
      audit.record("lead_deleted", {
        clientId,
        leadId: params.id,
        runId: existing.runId ?? null,
        action: "delete",
      });
    }

    reply.code(200);
    return { status: "deleted", id: params.id };
  });
}
