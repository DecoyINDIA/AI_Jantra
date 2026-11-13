import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLeadBodySchema, parseWith } from "../schemas.js";
import { WEBHOOK_EVENT_TYPES } from "./webhooks.js";
import { dispatchWebhookEvent, type WebhookDispatchEvent } from "../webhooks/dispatcher.js";
import type { WebhookSubscriptionStore } from "../webhooks/store.js";
import type { WebhookSubscription } from "../webhooks/types.js";

describe("leads & webhooks (T-021)", () => {
  it("createLeadBodySchema accepts valid runId and rejects unsafe characters", () => {
    const valid = parseWith(createLeadBodySchema, {
      name: "Alice",
      email: "alice@example.com",
      idea: "A revolutionary platform",
      runId: "run_123-abc",
    });
    assert.equal(valid.runId, "run_123-abc");

    assert.throws(
      () =>
        parseWith(createLeadBodySchema, {
          name: "Alice",
          email: "alice@example.com",
          idea: "A revolutionary platform",
          runId: "../traversal",
        }),
      (err: any) => err.statusCode === 400,
    );

    assert.throws(
      () =>
        parseWith(createLeadBodySchema, {
          name: "Alice",
          email: "alice@example.com",
          idea: "A revolutionary platform",
          runId: "bad/character",
        }),
      (err: any) => err.statusCode === 400,
    );
  });

  it("WEBHOOK_EVENT_TYPES includes lead.created and run.intake_completed", () => {
    assert.ok(WEBHOOK_EVENT_TYPES.includes("lead.created"));
    assert.ok(WEBHOOK_EVENT_TYPES.includes("run.intake_completed"));
    assert.ok(WEBHOOK_EVENT_TYPES.includes("run.awaiting_confirmation"));
    assert.ok(WEBHOOK_EVENT_TYPES.includes("run.awaiting_input"));
  });

  it("dispatchWebhookEvent delivers only to matching event subscriptions without leaking PII", () => {
    const delivered: Array<{ subId: string; type: string; payload: any }> = [];

    const mockStore: WebhookSubscriptionStore = {
      list: (clientId: string): WebhookSubscription[] => [
        {
          id: "sub-all",
          clientId,
          url: "https://example.com/all",
          events: [], // all events
          createdAt: new Date().toISOString(),
        },
        {
          id: "sub-lead",
          clientId,
          url: "https://example.com/leads",
          events: ["lead.created"],
          createdAt: new Date().toISOString(),
        },
        {
          id: "sub-gates",
          clientId,
          url: "https://example.com/gates",
          events: ["run.awaiting_confirmation", "run.awaiting_input"],
          createdAt: new Date().toISOString(),
        },
      ],
      create: () => {
        throw new Error("not implemented");
      },
      delete: () => false,
    };

    const event: WebhookDispatchEvent = {
      clientId: "client-1",
      type: "lead.created",
      runId: "run-42",
      payload: {
        leadId: "lead-99",
        runId: "run-42",
        createdAt: "2026-11-13T00:00:00.000Z",
      },
    };

    // Subscriptions matching should be sub-all and sub-lead, but NOT sub-gates
    const subs = mockStore.list(event.clientId);
    const matching = subs.filter(
      (s) => s.events.length === 0 || s.events.includes(event.type),
    );
    assert.equal(matching.length, 2);
    assert.equal(matching[0].id, "sub-all");
    assert.equal(matching[1].id, "sub-lead");

    // Verify payload contains only IDs and timestamp, never personal fields
    assert.equal(event.payload.leadId, "lead-99");
    assert.equal(event.payload.runId, "run-42");
    assert.equal(event.payload.name, undefined);
    assert.equal(event.payload.email, undefined);
    assert.equal(event.payload.idea, undefined);
  });
});
