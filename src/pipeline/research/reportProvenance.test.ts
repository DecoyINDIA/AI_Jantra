import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkReportProvenance } from "./reportProvenance.js";

describe("reportProvenance", () => {
  const knownSourceIds = ["s1", "s2"];

  it("passes when all citations resolve and numbers are present in baseline", () => {
    const baselineReport = "Revenue was $10M in 2025 across 50 markets [s1].";
    const finalReport = "According to [s1], revenue was $10M in 2025 across 50 markets.";
    const result = checkReportProvenance({
      finalReport,
      baselineReport,
      verifiedClaims: [],
      knownSourceIds,
    });
    assert.equal(result.ok, true);
    assert.equal(result.orphanNumbers.length, 0);
    assert.equal(result.unknownSourceRefs.length, 0);
  });

  it("ignores small integers up to 12 as common text words", () => {
    const baselineReport = "The system has multiple stages.";
    const finalReport = "The system has 3 stages and 4 criteria.";
    const result = checkReportProvenance({
      finalReport,
      baselineReport,
      verifiedClaims: [],
      knownSourceIds,
    });
    assert.equal(result.ok, true);
  });

  it("ignores numbers in markdown link URLs", () => {
    const baselineReport = "See documentation.";
    const finalReport = "See [doc](https://example.com/item/99998888).";
    const result = checkReportProvenance({
      finalReport,
      baselineReport,
      verifiedClaims: [],
      knownSourceIds,
    });
    assert.equal(result.ok, true);
  });

  it("rejects report containing hallucinated orphan numbers not in baseline", () => {
    const baselineReport = "Spending reached $10M.";
    const finalReport = "Spending reached $99M in a 450 surge.";
    const result = checkReportProvenance({
      finalReport,
      baselineReport,
      verifiedClaims: [],
      knownSourceIds,
    });
    assert.equal(result.ok, false);
    assert.ok(result.orphanNumbers.length > 0);
  });

  it("rejects report referencing unregistered source tags", () => {
    const baselineReport = "Revenue was $10M.";
    const finalReport = "Revenue was $10M [s999].";
    const result = checkReportProvenance({
      finalReport,
      baselineReport,
      verifiedClaims: [],
      knownSourceIds,
    });
    assert.equal(result.ok, false);
    assert.ok(result.unknownSourceRefs.includes("s999"));
  });
});
