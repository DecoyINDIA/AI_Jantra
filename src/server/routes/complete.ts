import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { AuditLogger } from "../../audit.js";
import { config } from "../../config.js";
import { createProviderForStage } from "../../model/index.js";
import { completeBodySchema, parseWith } from "../schemas.js";
import { requestClientId } from "../tenancy.js";

interface CompleteRouteDeps {
  clientId: string;
}

export function registerCompleteRoutes(app: FastifyInstance, deps: CompleteRouteDeps): void {
  app.post("/v1/complete", async (request, reply) => {
    const clientId = requestClientId(request, deps.clientId);
    const body = parseWith(completeBodySchema, request.body);

    const provider = createProviderForStage("complete", "flash", "gateway", body.modelId);
    
    const started = Date.now();
    const result = await provider.generate({
      system: body.system,
      messages: [{ role: "user", content: body.user }],
      responseJsonSchema: body.responseJsonSchema,
      maxOutputTokens: body.maxOutputTokens,
      temperature: body.temperature,
      grounding: false,
    });

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
