import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimRejectionReason,
  normalizeSourceText,
  sourceAppendix,
} from "./citationVerifier.js";
import type { Claim, Source } from "../types.js";

describe("citationVerifier", () => {
  describe("normalizeSourceText", () => {
    it("lowercases and collapses whitespace", () => {
      assert.equal(
        normalizeSourceText("  Hello \t\n World!  "),
        "hello world!",
      );
    });
  });

  describe("claimRejectionReason", () => {
    const sourceIds = new Set(["src-1", "src-2"]);
    const sourceTexts = new Map([
      ["src-1", "Global enterprise AI spending reached $45B in 2025."],
      ["src-2", "Operations agents reduce manual reconciliation time by 80%."],
    ]);

    it("accepts verbatim cited quote from registered source", () => {
      const claim: Claim = {
        text: "Spending reached $45B",
        citations: [{ sourceId: "src-1", quote: "spending reached $45B" }],
        sourceIds: ["src-1"],
        verified: false,
        support: "unverified",
      };
      assert.equal(claimRejectionReason(claim, sourceIds, sourceTexts), null);
    });

    it("rejects claim with no citations", () => {
      const claim: Claim = {
        text: "Uncited claim",
        citations: [],
        sourceIds: [],
        verified: false,
        support: "unverified",
      };
      assert.equal(claimRejectionReason(claim, sourceIds, sourceTexts), "no_citation");
    });

    it("rejects claim citing unregistered source ID", () => {
      const claim: Claim = {
        text: "Unknown source claim",
        citations: [{ sourceId: "src-999", quote: "some quote" }],
        sourceIds: ["src-999"],
        verified: false,
        support: "unverified",
      };
      assert.equal(claimRejectionReason(claim, sourceIds, sourceTexts), "unknown_source");
    });

    it("rejects claim whose quote is not found in the source text", () => {
      const claim: Claim = {
        text: "Fabricated quote claim",
        citations: [{ sourceId: "src-1", quote: "spending reached $500B overnight" }],
        sourceIds: ["src-1"],
        verified: false,
        support: "unverified",
      };
      assert.equal(claimRejectionReason(claim, sourceIds, sourceTexts), "quote_not_found");
    });
  });

  describe("sourceAppendix", () => {
    it("formats source list correctly", () => {
      const sources: Source[] = [
        {
          id: "s1",
          clientId: "client-1",
          title: "Market Report",
          url: "https://example.com/report",
          retrievedAt: "2026-06-01T00:00:00Z",
          contentHash: "abc123hash",
          qualityScore: 9,
        },
      ];
      const appendix = sourceAppendix(sources);
      assert.ok(appendix.includes("[s1] Market Report. https://example.com/report"));
    });

    it("returns placeholder when sources list is empty", () => {
      assert.equal(sourceAppendix([]), "No sources were registered.");
    });
  });
});
