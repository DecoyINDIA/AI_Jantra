import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import { createProviderForStage } from "../../model/index.js";
import { completeBodySchema, parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";
import { defaultStore, type ProjectStore } from "../../pipeline/store.js";
import {
  reserveGatewayBudget,
  settleGatewayBudget,
  auditClientDailyGatewayBudgetExceeded,
} from "../../runtime/gatewayBudget.js";

interface CompleteRouteDeps {
  clientId: string;
  store?: ProjectStore;
}

export function registerCompleteRoutes(app: FastifyInstance, deps: CompleteRouteDeps): void {
  const store = deps.store ?? defaultStore;

  app.post("/v1/complete", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(completeBodySchema, request.body);

    const estimate = config.gatewayRunCeilingUsd;
    const reservation = reserveGatewayBudget(store, clientId, estimate);
    if (!reservation.ok) {
      auditClientDailyGatewayBudgetExceeded(clientId, {
        spend: reservation.spend,
        ceiling: reservation.ceiling,
        day: reservation.day,
      });
      return reply.status(429).send({
        error: {
          code: "gateway_daily_budget_exceeded",
          message: "Gateway daily budget exceeded.",
          details: {
            spend: reservation.spend,
            ceiling: reservation.ceiling,
            day: reservation.day,
          },
        },
      });
    }

    const provider = createProviderForStage("complete", "flash", "gateway", body.modelId);
    
    const started = Date.now();
    let result;
    try {
      result = await provider.generate({
        purpose: body.purpose ?? "gateway_completion",
        system: body.system,
        messages: [{ role: "user", content: body.user }],
        responseJsonSchema: body.responseJsonSchema,
        maxOutputTokens: body.maxOutputTokens,
        temperature: body.temperature,
        grounding: false,
      });
    } catch (err) {
      settleGatewayBudget(store, clientId, estimate, 0, reservation.day);
      throw err;
    }
    settleGatewayBudget(store, clientId, estimate, result.costUsd, reservation.day);

    const latencyMs = Date.now() - started;
    const runId = `gateway-${randomUUID()}`;
    const audit = new AuditLogger(runId, config.auditDir);
    
    audit.record("gateway_completion", {
      clientId,
      purpose: body.purpose ?? "gateway_completion",
      model: result.modelId,
      tokens: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
      costUsd: result.costUsd,
      latencyMs,
      textChars: result.text.length,
    });

    if (result.costUsd > config.gatewayRunCeilingUsd) {
      audit.record("gateway_cost_exceeded", {
        clientId,
        costUsd: result.costUsd,
        ceilingUsd: config.gatewayRunCeilingUsd,
      });
    }

    return {
      text: result.text,
      model: result.modelId,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
      costUsd: result.costUsd,
      latencyMs,
    };
  });
}
