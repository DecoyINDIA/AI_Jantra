import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decomposeSeries } from "./anomalyEngine.js";

describe("anomalyEngine", () => {
  describe("decomposeSeries", () => {
    it("decomposes short series with trend only fallback", () => {
      const data = [10, 12, 11, 13, 12, 14];
      const result = decomposeSeries(data, 7);
      assert.equal(result.trend.length, data.length);
      assert.equal(result.seasonal.length, data.length);
      assert.equal(result.residual.length, data.length);
      // Trend values should be positive and non-zero
      for (const t of result.trend) {
        assert.ok(t > 0);
      }
    });

    it("handles longer series with seasonal patterns", () => {
      // 14 days of repeating pattern
      const data = [10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20];
      const result = decomposeSeries(data, 2);
      assert.equal(result.trend.length, data.length);
      assert.equal(result.seasonal.length, data.length);
      assert.equal(result.residual.length, data.length);
    });
  });
});
