import type { DataSnapshot } from "./schema.js";

function getDateField(table: string): string | null {
  switch (table) {
    case "orders":
      return "orderDate";
    case "invoices":
      return "invoiceDate";
    case "payments":
      return "paymentDate";
    case "expenses":
      return "expenseDate";
    case "subscription_events":
      return "eventDate";
    default:
      return null;
  }
}

export function evaluateTerm(
  func: "sum" | "count",
  table: string,
  field: string,
  filterStr: string | undefined,
  snapshot: any,
  startDate: string,
  endDate: string,
): number {
  const list = snapshot[table];
  if (!list) {
    throw new Error(`Formula evaluation failed: Table "${table}" does not exist in snapshot.`);
  }
  if (!Array.isArray(list)) {
    throw new Error(`Formula evaluation failed: Expected table "${table}" to be an array in snapshot.`);
  }

  // 1. Filter by date range if the table has a date field
  const dateField = getDateField(table);
  let filtered = list;
  if (dateField) {
    filtered = list.filter((item: any) => {
      const dateVal = item[dateField];
      return typeof dateVal === "string" && dateVal >= startDate && dateVal <= endDate;
    });
  }

  // 2. Filter by column match if filter is specified (e.g., [category=cogs])
  if (filterStr) {
    const eqIdx = filterStr.indexOf("=");
    if (eqIdx !== -1) {
      const key = filterStr.slice(0, eqIdx).trim();
      const valStr = filterStr.slice(eqIdx + 1).trim();
      const allowedValues = valStr.split(",").map((v) => v.trim());
      filtered = filtered.filter((item: any) => {
        const val = item[key];
        return val !== undefined && allowedValues.includes(String(val));
      });
    }
  }

  // 3. Compute sum or count
  if (func === "count") {
    return filtered.length;
  } else if (func === "sum") {
    let sum = 0;
    for (const item of filtered) {
      if (!(field in item)) {
        throw new Error(`Formula evaluation failed: Field "${field}" does not exist in table "${table}".`);
      }
      const val = Number(item[field]);
      if (Number.isFinite(val)) {
        sum += val;
      }
    }
    return sum;
  }

  return 0;
}

/**
 * Evaluates a simple arithmetic expression containing numbers, brackets, +, -, *, /
 * Safely parses the token sequence to avoid using eval().
 */
export function evaluateArithmetic(expr: string): number {
  // Tokenize the expression
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const char = expr[i]!;
    if (/\s/.test(char)) {
      i++;
    } else if (/[+\-*/()]/.test(char)) {
      tokens.push(char);
      i++;
    } else if (/[0-9.]/.test(char)) {
      let numStr = "";
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        numStr += expr[i];
        i++;
      }
      tokens.push(numStr);
    } else {
      i++;
    }
  }

  let tokenIndex = 0;

  function parsePrimary(): number {
    const token = tokens[tokenIndex];
    if (!token) return 0;
    if (token === "(") {
      tokenIndex++; // skip '('
      const val = parseExpression();
      if (tokens[tokenIndex] === ")") {
        tokenIndex++; // skip ')'
      }
      return val;
    }
    if (token === "-") {
      tokenIndex++; // skip '-'
      return -parsePrimary();
    }
    if (token === "+") {
      tokenIndex++; // skip '+'
      return parsePrimary();
    }
    // Assume number
    tokenIndex++;
    const val = Number(token);
    return Number.isFinite(val) ? val : 0;
  }

  function parseMultiplicative(): number {
    let val = parsePrimary();
    while (tokenIndex < tokens.length) {
      const op = tokens[tokenIndex];
      if (op === "*" || op === "/") {
        tokenIndex++;
        const nextVal = parsePrimary();
        if (op === "*") {
          val *= nextVal;
        } else {
          val = nextVal === 0 ? 0 : val / nextVal;
        }
      } else {
        break;
      }
    }
    return val;
  }

  function parseExpression(): number {
    let val = parseMultiplicative();
    while (tokenIndex < tokens.length) {
      const op = tokens[tokenIndex];
      if (op === "+" || op === "-") {
        tokenIndex++;
        const nextVal = parseMultiplicative();
        if (op === "+") {
          val += nextVal;
        } else {
          val -= nextVal;
        }
      } else {
        break;
      }
    }
    return val;
  }

  const result = parseExpression();
  return Number.isNaN(result) ? 0 : result;
}

/**
 * Main entry point: parses KPI formula and evaluates it over a snapshot
 */
export function evaluateFormula(
  formula: string,
  snapshot: DataSnapshot,
  startDate: string,
  endDate: string,
): number {
  // Regex to match term: sum(table.field[filter]) or count(table.field[filter])
  const termRegex = /(sum|count)\(([^[)]+)(?:\[([^\]]+)\])?\)/g;

  let evaluatedFormula = formula;
  let match;

  while (true) {
    termRegex.lastIndex = 0;
    match = termRegex.exec(evaluatedFormula);
    if (!match) break;

    const fullMatch = match[0];
    const func = match[1] as "sum" | "count";
    const path = match[2]!.trim();
    const filterStr = match[3];

    const dotIdx = path.indexOf(".");
    if (dotIdx === -1) {
      throw new Error(`Formula evaluation failed: Invalid term path "${path}".`);
    }

    const table = path.slice(0, dotIdx).trim();
    const field = path.slice(dotIdx + 1).trim();

    const value = evaluateTerm(func, table, field, filterStr, snapshot, startDate, endDate);
    evaluatedFormula = evaluatedFormula.replace(fullMatch, String(value));
  }

  return evaluateArithmetic(evaluatedFormula);
}

/**
 * Validates the syntax, tables, and fields in a KPI formula
 */
export function validateFormula(formula: string): { valid: boolean; error?: string } {
  const termRegex = /(sum|count)\(([^[)]+)(?:\[([^\]]+)\])?\)/g;
  const matches = [...formula.matchAll(termRegex)];

  // Valid tables and their fields
  const tableFields: Record<string, Set<string>> = {
    orders: new Set(["id", "customerId", "productId", "channelId", "amount", "currency", "orderDate", "quantity"]),
    order_lines: new Set(["id", "orderId", "productId", "amount", "quantity"]),
    invoices: new Set(["id", "customerId", "amount", "currency", "invoiceDate", "dueDate", "status"]),
    payments: new Set(["id", "invoiceId", "amount", "currency", "paymentDate", "status"]),
    expenses: new Set(["id", "category", "amount", "currency", "expenseDate", "description"]),
    subscription_events: new Set(["id", "customerId", "type", "monthlyValue", "eventDate"]),
    customers: new Set(["id", "name", "cohortMonth"]),
    products: new Set(["id", "name", "category", "sku"]),
    channels: new Set(["id", "name"]),
    calendar: new Set(["date", "week", "month", "year", "isHoliday", "isPromo"]),
  };

  for (const m of matches) {
    const path = m[2]!.trim();
    const filterStr = m[3];

    const dotIdx = path.indexOf(".");
    if (dotIdx === -1) {
      return { valid: false, error: `Invalid term path: "${path}". Expected table.field.` };
    }
    const table = path.slice(0, dotIdx).trim();
    const field = path.slice(dotIdx + 1).trim();

    const fields = tableFields[table];
    if (!fields) {
      return { valid: false, error: `Invalid table: "${table}". Must be one of: ${Object.keys(tableFields).join(", ")}.` };
    }
    if (!fields.has(field)) {
      return { valid: false, error: `Invalid field: "${field}" in table "${table}".` };
    }

    if (filterStr) {
      const eqIdx = filterStr.indexOf("=");
      if (eqIdx === -1) {
        return { valid: false, error: `Invalid filter: "${filterStr}". Expected key=value.` };
      }
      const key = filterStr.slice(0, eqIdx).trim();
      if (!fields.has(key)) {
        return { valid: false, error: `Invalid filter key: "${key}" in table "${table}".` };
      }
    }
  }

  return { valid: true };
}
