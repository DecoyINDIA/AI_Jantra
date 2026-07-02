import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OpsConnector, ConnectorConfig } from "./base.js";
import type { DataSnapshot } from "../schema.js";

function parseCsvRow(row: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export function parseCsv(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseCsvRow);
}

function autoMapHeaders(headers: string[], targetTable: string): Record<string, string> {
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
    } else if (targetTable === "order_lines") {
      if (clean === "id" || clean === "lineid") {
        mapping[header] = "id";
      } else if (clean === "orderid") {
        mapping[header] = "orderId";
      } else if (clean === "productid" || clean === "sku") {
        mapping[header] = "productId";
      } else if (clean === "amount" || clean === "price") {
        mapping[header] = "amount";
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
    } else if (targetTable === "subscription_events") {
      if (clean === "id" || clean === "eventid") {
        mapping[header] = "id";
      } else if (clean === "customer" || clean === "customerid") {
        mapping[header] = "customerId";
      } else if (clean === "type" || clean === "action") {
        mapping[header] = "type";
      } else if (clean === "monthlyvalue" || clean === "value" || clean === "mrr") {
        mapping[header] = "monthlyValue";
      } else if (clean === "date" || clean === "eventdate" || clean === "createdat") {
        mapping[header] = "eventDate";
      }
    } else if (targetTable === "invoices") {
      if (clean === "id" || clean === "invoiceid") {
        mapping[header] = "id";
      } else if (clean === "customer" || clean === "customerid") {
        mapping[header] = "customerId";
      } else if (clean === "amount" || clean === "total") {
        mapping[header] = "amount";
      } else if (clean === "currency") {
        mapping[header] = "currency";
      } else if (clean === "date" || clean === "invoicedate") {
        mapping[header] = "invoiceDate";
      } else if (clean === "duedate") {
        mapping[header] = "dueDate";
      } else if (clean === "status") {
        mapping[header] = "status";
      }
    } else if (targetTable === "payments") {
      if (clean === "id" || clean === "paymentid") {
        mapping[header] = "id";
      } else if (clean === "invoiceid") {
        mapping[header] = "invoiceId";
      } else if (clean === "amount") {
        mapping[header] = "amount";
      } else if (clean === "currency") {
        mapping[header] = "currency";
      } else if (clean === "date" || clean === "paymentdate") {
        mapping[header] = "paymentDate";
      } else if (clean === "status") {
        mapping[header] = "status";
      }
    }
  }
  return mapping;
}

export class CsvConnector implements OpsConnector {
  constructor(readonly id: string) {}

  async fetch(cfg: ConnectorConfig): Promise<Partial<DataSnapshot>> {
    const role = cfg.config.role;
    const clientId = cfg.clientId;
    
    // Default directory: data/ops/<clientId>/
    const dir = cfg.config.directory || path.join("data", "ops", clientId);
    const snapshot: Partial<DataSnapshot> = {};

    const loadTable = async (fileName: string, targetTable: keyof DataSnapshot) => {
      const filePath = path.join(dir, fileName);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const rows = parseCsv(content);
        if (rows.length < 2) return;

        const headers = rows[0]!;
        const dataRows = rows.slice(1);
        const mapping = cfg.config.fieldMapping?.[targetTable] || autoMapHeaders(headers, targetTable);

        const items: any[] = [];
        for (const row of dataRows) {
          const item: Record<string, any> = {};
          for (let i = 0; i < headers.length; i++) {
            const header = headers[i]!;
            const canonicalField = mapping[header];
            if (canonicalField) {
              const val = row[i];
              if (val !== undefined) {
                // Parse numbers/booleans where expected
                if (["amount", "quantity", "monthlyValue", "week", "month", "year"].includes(canonicalField)) {
                  item[canonicalField] = Number(val);
                } else if (["isHoliday", "isPromo"].includes(canonicalField)) {
                  item[canonicalField] = val.toLowerCase() === "true" || val === "1";
                } else {
                  item[canonicalField] = val;
                }
              }
            }
          }
          items.push(item);
        }
        snapshot[targetTable] = items as any;
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    };

    if (role === "sales") {
      await loadTable("orders.csv", "orders");
      await loadTable("order_lines.csv", "order_lines");
      await loadTable("products.csv", "products");
      await loadTable("customers.csv", "customers");
    } else if (role === "expenses") {
      await loadTable("expenses.csv", "expenses");
    } else if (role === "subscriptions") {
      await loadTable("subscription_events.csv", "subscription_events");
      await loadTable("customers.csv", "customers");
    } else if (role === "invoices") {
      await loadTable("invoices.csv", "invoices");
      await loadTable("payments.csv", "payments");
      await loadTable("customers.csv", "customers");
    }

    return snapshot;
  }
}
