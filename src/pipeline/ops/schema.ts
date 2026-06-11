import { z } from "zod";

// --- Dimensions ---

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  cohortMonth: z.string(), // YYYY-MM
});
export type Customer = z.infer<typeof CustomerSchema>;

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  sku: z.string().optional(),
});
export type Product = z.infer<typeof ProductSchema>;

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(), // e.g. "Shopify", "Stripe", "Retail POS"
});
export type Channel = z.infer<typeof ChannelSchema>;

export const CalendarSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  week: z.number().int(),
  month: z.number().int(),
  year: z.number().int(),
  isHoliday: z.boolean().default(false),
  isPromo: z.boolean().default(false),
});
export type Calendar = z.infer<typeof CalendarSchema>;

// --- Facts ---

export const OrderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  productId: z.string(),
  channelId: z.string(),
  amount: z.number(),
  currency: z.string().default("USD"),
  orderDate: z.string(), // YYYY-MM-DD
  quantity: z.number().int().default(1),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderLineSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  productId: z.string(),
  amount: z.number(),
  quantity: z.number().int().default(1),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const InvoiceSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  amount: z.number(),
  currency: z.string().default("USD"),
  invoiceDate: z.string(), // YYYY-MM-DD
  dueDate: z.string(), // YYYY-MM-DD
  status: z.enum(["paid", "unpaid", "void"]).default("unpaid"),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const PaymentSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  amount: z.number(),
  currency: z.string().default("USD"),
  paymentDate: z.string(), // YYYY-MM-DD
  status: z.string().default("success"),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const ExpenseSchema = z.object({
  id: z.string(),
  category: z.string(),
  amount: z.number(),
  currency: z.string().default("USD"),
  expenseDate: z.string(), // YYYY-MM-DD
  description: z.string().optional(),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const SubscriptionEventSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  type: z.enum(["signup", "renew", "churn", "upgrade", "downgrade"]),
  monthlyValue: z.number(),
  eventDate: z.string(), // YYYY-MM-DD
});
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>;

// --- Complete Snapshot Schema ---

export const DataSnapshotSchema = z.object({
  orders: z.array(OrderSchema).default([]),
  order_lines: z.array(OrderLineSchema).default([]),
  invoices: z.array(InvoiceSchema).default([]),
  payments: z.array(PaymentSchema).default([]),
  expenses: z.array(ExpenseSchema).default([]),
  subscription_events: z.array(SubscriptionEventSchema).default([]),
  customers: z.array(CustomerSchema).default([]),
  products: z.array(ProductSchema).default([]),
  channels: z.array(ChannelSchema).default([]),
  calendar: z.array(CalendarSchema).default([]),
});
export type DataSnapshot = z.infer<typeof DataSnapshotSchema>;
