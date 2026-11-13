import type { StageEvalResult } from "../report.js";
import { runRegression } from "./common.js";
import {
  verifyAgentOutputCap,
  verifyAgentSystemPromptCache,
  verifyAgentThinkingBudget,
  verifyGeminiCacheDispose,
  verifyHandoffSkippedToolAudit,
  verifyResearchCheckpointPersisted,
  verifyUnknownModelCost,
  verifyUserMessageLengthGuard,
} from "./agent.js";
import {
  verifyClientDailyIdeationBudget,
  verifyGatewayDailyBudget,
  verifyGatewayReserveSettle,
  verifyIntakeSessionBudget,
  verifyVisitorDailyBudget,
} from "./budget.js";
import {
  verifyCsvDirectoryResolve,
  verifyOpsDeliveryHonest,
  verifyOpsNoSilentSynthetic,
} from "./ops.js";
import {
  verifyAgentPolicyArgs,
  verifyDefaultPolicyBehavior,
  verifyInjectionContentNeutralized,
  verifyReentrantPolicyArgs,
  verifyReportProvenanceRevert,
  verifyReportProvenanceUnit,
} from "./policy.js";
import {
  verifyAuditRedactionAndTruncation,
  verifyDataRootDerivation,
  verifyJsonStoreIgnoresNonProjectFiles,
  verifyPublicKeyScope,
  verifySafeFetchRedirect,
  verifyStorePathSegments,
  verifyWebhookUrlGuard,
} from "./security.js";
import {
  verifyErrorEnvelopeNoLeak,
  verifyLeadRunLinkAndWebhooks,
  verifyPromoteIntakeToPlan,
  verifyClientReadyExport,
  verifyRateLimiterFixedWindow,
  verifyRateLimiterProxyTrust,
  verifyRejectRoutePersistsReason,
  verifyRunIdPathTraversalRejected,
  verifyVisitorHeaderIgnoredForFullKeys,
  verifyVisitorRateLimit,
} from "./server.js";

export { runRegression } from "./common.js";

export async function runRegressionEvals(): Promise<StageEvalResult[]> {
  return [
    await runRegression("policy-defaults", verifyDefaultPolicyBehavior),
    await runRegression("policy-agent-args", verifyAgentPolicyArgs),
    await runRegression("policy-reentrant-args", verifyReentrantPolicyArgs),
    await runRegression("reject-route-reason", verifyRejectRoutePersistsReason),
    await runRegression("agent-thinking-budget", verifyAgentThinkingBudget),
    await runRegression("agent-output-cap", verifyAgentOutputCap),
    await runRegression("agent-system-cache", verifyAgentSystemPromptCache),
    await runRegression("audit-redaction-truncation", verifyAuditRedactionAndTruncation),
    await runRegression("user-message-length", verifyUserMessageLengthGuard),
    await runRegression("gemini-cache-dispose", verifyGeminiCacheDispose),
    await runRegression("handoff-skipped-tools", verifyHandoffSkippedToolAudit),
    await runRegression("intake-client-daily-budget", verifyClientDailyIdeationBudget),
    await runRegression("intake-session-budget", verifyIntakeSessionBudget),
    await runRegression("runid-path-traversal", verifyRunIdPathTraversalRejected),
    await runRegression("rate-limiter-fixed-window", verifyRateLimiterFixedWindow),
    await runRegression("rate-limiter-proxy-trust", verifyRateLimiterProxyTrust),
    await runRegression("webhook-url-guard", verifyWebhookUrlGuard),
    await runRegression("gateway-daily-budget", verifyGatewayDailyBudget),
    await runRegression("csv-directory-resolve", verifyCsvDirectoryResolve),
    await runRegression("data-root-derivation", verifyDataRootDerivation),
    await runRegression("injection-content-neutralized", verifyInjectionContentNeutralized),
    await runRegression("ops-delivery-honest", verifyOpsDeliveryHonest),
    await runRegression("ops-no-silent-synthetic", verifyOpsNoSilentSynthetic),
    await runRegression("public-key-scope", verifyPublicKeyScope),
    await runRegression("safe-fetch-redirect", verifySafeFetchRedirect),
    await runRegression("error-envelope-no-leak", verifyErrorEnvelopeNoLeak),
    await runRegression("json-store-ignores-non-project-files", verifyJsonStoreIgnoresNonProjectFiles),
    await runRegression("store-path-segments", verifyStorePathSegments),
    await runRegression("research-checkpoint-persisted", verifyResearchCheckpointPersisted),
    await runRegression("visitor-rate-limit", verifyVisitorRateLimit),
    await runRegression("visitor-header-ignored-for-full-keys", verifyVisitorHeaderIgnoredForFullKeys),
    await runRegression("visitor-daily-budget", verifyVisitorDailyBudget),
    await runRegression("report-provenance-unit", verifyReportProvenanceUnit),
    await runRegression("report-provenance-revert", verifyReportProvenanceRevert),
    await runRegression("gateway-reserve-settle", verifyGatewayReserveSettle),
    await runRegression("unknown-model-cost", verifyUnknownModelCost),
    await runRegression("lead-run-link-and-webhooks", verifyLeadRunLinkAndWebhooks),
    await runRegression("promote-intake-to-plan", verifyPromoteIntakeToPlan),
    await runRegression("client-ready-export", verifyClientReadyExport),
  ];
}
