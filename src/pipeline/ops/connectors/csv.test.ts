import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvRow } from "./csv.js";

describe("parseCsv", () => {
  describe("parseCsvRow", () => {
    it("parses unquoted comma-separated values", () => {
      assert.deepEqual(parseCsvRow("a,b,c"), ["a", "b", "c"]);
      assert.deepEqual(parseCsvRow("100,200,300"), ["100", "200", "300"]);
    });

    it("parses quoted values containing commas", () => {
      assert.deepEqual(parseCsvRow('"hello, world",42,"foo"'), ["hello, world", "42", "foo"]);
    });

    it("parses escaped quotes inside quoted values", () => {
      assert.deepEqual(parseCsvRow('"he said ""hello""",bar'), ['he said "hello"', "bar"]);
    });

    it("handles trailing and empty fields", () => {
      assert.deepEqual(parseCsvRow("a,,c,"), ["a", "", "c", ""]);
    });
  });

  describe("parseCsv", () => {
    it("parses multiline CSV content", () => {
      const csv = `id,name,amount
1,Alice,100
2,Bob,200`;
      const rows = parseCsv(csv);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], ["id", "name", "amount"]);
      assert.deepEqual(rows[1], ["1", "Alice", "100"]);
      assert.deepEqual(rows[2], ["2", "Bob", "200"]);
    });

    it("ignores empty lines", () => {
      const csv = `
header1,header2

val1,val2

`;
      const rows = parseCsv(csv);
      assert.equal(rows.length, 2);
    });
  });
});
