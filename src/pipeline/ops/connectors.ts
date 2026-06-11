import { z } from "zod";
import { DataSnapshotSchema, type DataSnapshot } from "./schema.js";

export interface DataQualityCheck {
  id: string;
  source: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DataQualityReport {
  verdict: "pass" | "pass-with-warnings" | "fail";
  checks: DataQualityCheck[];
}

export interface SourceBinding {
  connectors: {
    id: string; // e.g. "stripe-sales", "shopify-orders", "qb-expenses"
    type: "stripe" | "shopify" | "quickbooks" | "xero" | "csv";
    role: "sales" | "expenses" | "subscriptions" | "invoices";
    config: Record<string, any>;
  }[];
  overlapRules: {
    primarySource: string;
    secondarySource: string;
    action: "dedup-by-id" | "keep-both";
  }[];
}

/**
 * Runs the deterministic quality battery on the ingested snapshot
 */
export function runQualityBattery(
  originalSnapshot: DataSnapshot,
  binding: SourceBinding,
): { report: DataQualityReport; snapshot: DataSnapshot } {
  // Deep-clone to avoid mutating the original snapshot in-place
  const snapshot = JSON.parse(JSON.stringify(originalSnapshot)) as DataSnapshot;
  const checks: DataQualityCheck[] = [];

  // 1. Schema Drift Check (using DataSnapshotSchema safeParse)
  const parseResult = DataSnapshotSchema.safeParse(snapshot);
  if (!parseResult.success) {
    checks.push({
      id: "schema_drift",
      source: "all",
      status: "fail",
      detail: `Schema drift detected: ${parseResult.error.message}`,
    });
  } else {
    checks.push({
      id: "schema_drift",
      source: "all",
      status: "pass",
      detail: "No schema drift detected. All tables match canonical schema.",
    });
  }

  // 2. Reconciliation: Line items sum to headers (Order lines -> Orders)
  let orderLinesFail = false;
  let orderLinesDetail = "";
  if (snapshot.orders.length > 0 && snapshot.order_lines.length > 0) {
    for (const order of snapshot.orders) {
      const lines = snapshot.order_lines.filter((l) => l.orderId === order.id);
      if (lines.length > 0) {
        const sum = lines.reduce((acc, l) => acc + l.amount, 0);
        if (Math.abs(sum - order.amount) > 0.05) {
          orderLinesFail = true;
          orderLinesDetail = `Order ${order.id} amount ($${order.amount}) does not reconcile with sum of lines ($${sum}).`;
          break;
        }
      }
    }
  }

  if (orderLinesFail) {
    checks.push({
      id: "reconciliation_order_lines",
      source: "shopify",
      status: "fail", // Reconciliation failure MUST fail the stage closed
      detail: orderLinesDetail,
    });
  } else {
    checks.push({
      id: "reconciliation_order_lines",
      source: "shopify",
      status: "pass",
      detail: "Order line items sum perfectly to order header amounts.",
    });
  }

  // 3. Reconciliation: Payments tie to invoices
  let paymentsOverLimit = false;
  if (snapshot.payments.length > 0 && snapshot.invoices.length > 0) {
    for (const invoice of snapshot.invoices) {
      const pmts = snapshot.payments.filter((p) => p.invoiceId === invoice.id);
      const sum = pmts.reduce((acc, p) => acc + p.amount, 0);
      if (sum > invoice.amount + 0.05) {
        paymentsOverLimit = true;
        break;
      }
    }
  }

  if (paymentsOverLimit) {
    checks.push({
      id: "reconciliation_payments_invoices",
      source: "stripe/quickbooks",
      status: "fail", // Reconciliation failure MUST fail the stage closed
      detail: "Some invoice payments sum to more than the invoice total.",
    });
  } else {
    checks.push({
      id: "reconciliation_payments_invoices",
      source: "stripe/quickbooks",
      status: "pass",
      detail: "All payments match or are within their respective invoice balances.",
    });
  }

  // 4. Completeness Check
  for (const conn of binding.connectors) {
    let hasData = false;
    if (conn.role === "sales" && snapshot.orders.length > 0) hasData = true;
    if (conn.role === "expenses" && snapshot.expenses.length > 0) hasData = true;
    if (conn.role === "subscriptions" && snapshot.subscription_events.length > 0) hasData = true;
    if (conn.role === "invoices" && snapshot.invoices.length > 0) hasData = true;

    if (!hasData) {
      checks.push({
        id: `completeness_${conn.id}`,
        source: conn.id,
        status: "warn",
        detail: `No data returned from configured connector ${conn.id}.`,
      });
    } else {
      checks.push({
        id: `completeness_${conn.id}`,
        source: conn.id,
        status: "pass",
        detail: `Connector ${conn.id} active and returned data.`,
      });
    }
  }

  // 5. Cross-source duplicates and deduplication rules
  let overlapCount = 0;
  for (const rule of binding.overlapRules) {
    if (rule.action === "dedup-by-id") {
      const primaryConn = binding.connectors.find(c => c.id === rule.primarySource);
      const secondaryConn = binding.connectors.find(c => c.id === rule.secondarySource);
      const primaryChannelId = primaryConn ? primaryConn.type : rule.primarySource;
      const secondaryChannelId = secondaryConn ? secondaryConn.type : rule.secondarySource;

      const primaryOrders = snapshot.orders.filter((o) => o.channelId === primaryChannelId || o.channelId === rule.primarySource);
      const secondaryOrders = snapshot.orders.filter((o) => o.channelId === secondaryChannelId || o.channelId === rule.secondarySource);

      const matchedIds = new Set<string>();
      for (const po of primaryOrders) {
        for (const so of secondaryOrders) {
          if (po.orderDate === so.orderDate && Math.abs(po.amount - so.amount) < 0.01) {
            matchedIds.add(so.id);
            overlapCount++;
          }
        }
      }

      if (matchedIds.size > 0) {
        snapshot.orders = snapshot.orders.filter((o) => !matchedIds.has(o.id));
      }
    }
  }

  if (overlapCount > 0) {
    checks.push({
      id: "deduplication_overlap",
      source: "cross-source",
      status: "pass",
      detail: `Successfully deduplicated ${overlapCount} overlapping transactions.`,
    });
  } else {
    checks.push({
      id: "deduplication_overlap",
      source: "cross-source",
      status: "pass",
      detail: "No overlapping transactions found across channels.",
    });
  }

  // Determine Overall Verdict
  let verdict: DataQualityReport["verdict"] = "pass";
  if (checks.some((c) => c.status === "fail")) {
    verdict = "fail";
  } else if (checks.some((c) => c.status === "warn")) {
    verdict = "pass-with-warnings";
  }

  return { report: { verdict, checks }, snapshot };
}

/**
 * Proposes field mapping for a set of raw CSV columns to the canonical schema table fields
 */
export function proposeCsvMapping(
  headers: string[],
  targetTable: string,
): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const header of headers) {
    const clean = header.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (targetTable === "orders") {
      if (clean === "id" || clean === "orderid" || clean === "transactionid") {
        mapping[header] = "id";
      } else if (clean === "amount" || clean === "total" || clean === "revenue" || clean === "price") {
        mapping[header] = "amount";
      } else if (clean === "date" || clean === "orderdate" || clean === "createdat") {
        mapping[header] = "orderDate";
      } else if (clean === "customer" || clean === "customerid" || clean === "email") {
        mapping[header] = "customerId";
      } else if (clean === "product" || clean === "productid" || clean === "sku") {
        mapping[header] = "productId";
      } else if (clean === "channel" || clean === "source") {
        mapping[header] = "channelId";
      } else if (clean === "quantity" || clean === "qty") {
        mapping[header] = "quantity";
      }
    } else if (targetTable === "expenses") {
      if (clean === "id" || clean === "expenseid" || clean === "transactionid") {
        mapping[header] = "id";
      } else if (clean === "amount" || clean === "total" || clean === "cost") {
        mapping[header] = "amount";
      } else if (clean === "date" || clean === "expensedate" || clean === "createdat") {
        mapping[header] = "expenseDate";
      } else if (clean === "category" || clean === "type") {
        mapping[header] = "category";
      } else if (clean === "description" || clean === "memo" || clean === "notes") {
        mapping[header] = "description";
      }
    }
  }

  return mapping;
}
