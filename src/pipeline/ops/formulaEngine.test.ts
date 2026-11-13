import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateArithmetic, evaluateFormula } from "./formulaEngine.js";

describe("formulaEngine", () => {
  describe("evaluateArithmetic", () => {
    it("evaluates basic arithmetic operations", () => {
      assert.equal(evaluateArithmetic("10 + 5"), 15);
      assert.equal(evaluateArithmetic("20 - 8"), 12);
      assert.equal(evaluateArithmetic("6 * 7"), 42);
      assert.equal(evaluateArithmetic("100 / 4"), 25);
    });

    it("respects operator precedence and parentheses", () => {
      assert.equal(evaluateArithmetic("2 + 3 * 4"), 14);
      assert.equal(evaluateArithmetic("(2 + 3) * 4"), 20);
      assert.equal(evaluateArithmetic("100 - (20 + 30)"), 50);
      assert.equal(evaluateArithmetic("((10 + 10) * 2) / 4"), 10);
    });

    it("handles division by zero gracefully", () => {
      assert.equal(evaluateArithmetic("10 / 0"), 0);
    });

    it("handles decimal numbers and negative signs", () => {
      assert.equal(evaluateArithmetic("2.5 * 4"), 10);
      assert.equal(evaluateArithmetic("-5 + 15"), 10);
      assert.equal(evaluateArithmetic("10 + -3"), 7);
    });

    it("returns 0 on empty or invalid input", () => {
      assert.equal(evaluateArithmetic(""), 0);
      assert.equal(evaluateArithmetic("   "), 0);
    });
  });

  describe("evaluateFormula", () => {
    const snapshot = {
      orders: [
        { id: "1", orderDate: "2026-06-01", amount: 100, channelId: "web" },
        { id: "2", orderDate: "2026-06-15", amount: 200, channelId: "app" },
        { id: "3", orderDate: "2026-07-01", amount: 300, channelId: "web" },
      ],
      expenses: [
        { id: "e1", expenseDate: "2026-06-10", amount: 50, category: "ads" },
      ],
    } as any;

    it("evaluates sum and count across date ranges", () => {
      const sumOrders = evaluateFormula("sum(orders.amount)", snapshot, "2026-06-01", "2026-06-30");
      assert.equal(sumOrders, 300);

      const countOrders = evaluateFormula("count(orders.id)", snapshot, "2026-06-01", "2026-06-30");
      assert.equal(countOrders, 2);
    });

    it("evaluates composite formula with filters", () => {
      const profit = evaluateFormula(
        "sum(orders.amount) - sum(expenses.amount)",
        snapshot,
        "2026-06-01",
        "2026-06-30",
      );
      assert.equal(profit, 250);
    });
  });
});
