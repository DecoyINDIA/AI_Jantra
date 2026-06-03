import type { FastifyInstance } from "fastify";

import type { AgentRegistry } from "../../agents/registry.js";
import { notFound } from "../errors.js";
import { agentParamsSchema, parseWith } from "../schemas.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  registry: AgentRegistry,
): void {
  app.get("/v1/agents", async () => ({
    agents: registry.list(),
  }));

  app.get("/v1/agents/:agentId", async (request) => {
    const params = parseWith(agentParamsSchema, request.params);
    try {
      return { agent: registry.get(params.agentId) };
    } catch {
      throw notFound(`Agent ${params.agentId} was not found.`);
    }
  });
}
