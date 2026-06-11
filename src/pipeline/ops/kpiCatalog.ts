export interface KpiDef {
  id: string;
  name: string;
  definition: string;
  formula: string;
  grain: "day" | "week" | "month";
  directionOfGood: "up" | "down" | "range";
  target: number | null;
  minHistoryPeriods: number;
  source: "catalog" | "derived";
  rationale: string | null;
}

export const KPI_CATALOG: Record<string, KpiDef[]> = {
  "ecommerce": [
    {
      id: "revenue",
      name: "Total Revenue",
      definition: "Total sales revenue from orders",
      formula: "sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "aov",
      name: "Average Order Value",
      definition: "Average dollar value spent per order",
      formula: "sum(orders.amount) / count(orders.id)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "orders_count",
      name: "Order Volume",
      definition: "Total number of orders processed",
      formula: "count(orders.id)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "gross_margin",
      name: "Gross Margin %",
      definition: "Percentage of revenue kept after cost of goods sold",
      formula: "(sum(orders.amount) - sum(expenses.amount[category=cogs])) / sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "saas-subscription": [
    {
      id: "mrr",
      name: "Monthly Recurring Revenue",
      definition: "Total monthly recurring value of active subscriptions",
      formula: "sum(subscription_events.monthlyValue[type=signup,renew,upgrade]) - sum(subscription_events.monthlyValue[type=churn,downgrade])",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "churn_rate",
      name: "Logo Churn Rate",
      definition: "Ratio of churned subscribers to total subscribers",
      formula: "count(subscription_events.id[type=churn]) / count(subscription_events.id[type=signup,renew])",
      grain: "month",
      directionOfGood: "down",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "arpu",
      name: "Average Revenue Per User",
      definition: "Average revenue generated per active subscription",
      formula: "sum(subscription_events.monthlyValue) / count(subscription_events.customerId)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "services": [
    {
      id: "billings",
      name: "Total Billings",
      definition: "Sum of all invoiced values",
      formula: "sum(invoices.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "expenses",
      name: "Total Operating Expenses",
      definition: "Sum of all business operational expenses",
      formula: "sum(expenses.amount)",
      grain: "month",
      directionOfGood: "down",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "net_profit",
      name: "Net Profit",
      definition: "Billing revenue minus operating expenses",
      formula: "sum(invoices.amount) - sum(expenses.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "retail-pos": [
    {
      id: "revenue",
      name: "Total Revenue",
      definition: "Total sales revenue from retail transactions",
      formula: "sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "basket_size",
      name: "Average Basket Size",
      definition: "Average revenue per transaction",
      formula: "sum(orders.amount) / count(orders.id)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "hospitality": [
    {
      id: "revenue",
      name: "Total Bookings Revenue",
      definition: "Total revenue generated from bookings",
      formula: "sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "wholesale-manufacturing": [
    {
      id: "revenue",
      name: "Wholesale Revenue",
      definition: "Total wholesale orders revenue",
      formula: "sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "cogs",
      name: "Cost of Goods Sold",
      definition: "Total manufacturing and raw material costs",
      formula: "sum(expenses.amount[category=cogs])",
      grain: "month",
      directionOfGood: "down",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ],
  "other": [
    {
      id: "revenue",
      name: "Total Revenue",
      definition: "Standard total revenue",
      formula: "sum(orders.amount)",
      grain: "month",
      directionOfGood: "up",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    },
    {
      id: "expenses",
      name: "Total Expenses",
      definition: "Standard total expenses",
      formula: "sum(expenses.amount)",
      grain: "month",
      directionOfGood: "down",
      target: null,
      minHistoryPeriods: 6,
      source: "catalog",
      rationale: null,
    }
  ]
};
