/**
 * A tiny in-memory stand-in for the systems a real support agent would touch
 * (helpdesk, order DB, knowledge base). In production each of these becomes a
 * real integration; the tool surface the agent sees stays identical.
 */

export interface Order {
  id: string;
  email: string;
  item: string;
  amountCents: number;
  status: "delivered" | "in_transit" | "processing" | "cancelled";
  placedAt: string;
  refundedCents: number;
}

const ORDERS: Record<string, Order> = {
  "A-1001": {
    id: "A-1001",
    email: "dana@example.com",
    item: "Aeron desk lamp",
    amountCents: 8900,
    status: "delivered",
    placedAt: "2026-05-20",
    refundedCents: 0,
  },
  "A-1002": {
    id: "A-1002",
    email: "dana@example.com",
    item: "Walnut monitor stand",
    amountCents: 12900,
    status: "in_transit",
    placedAt: "2026-05-28",
    refundedCents: 0,
  },
  "A-2050": {
    id: "A-2050",
    email: "sam@example.com",
    item: "Standing desk converter",
    amountCents: 32900,
    status: "delivered",
    placedAt: "2026-04-02",
    refundedCents: 0,
  },
};

const KNOWLEDGE_BASE: { topic: string; body: string }[] = [
  {
    topic: "returns and refunds",
    body: "Items can be returned within 30 days of delivery for a full refund. After 30 days, returns are case by case. Refunds go back to the original payment method within 5 to 7 business days.",
  },
  {
    topic: "shipping times",
    body: "Standard shipping is 3 to 5 business days. Express is 1 to 2. In transit orders cannot be cancelled, but can be refused on delivery for a return.",
  },
  {
    topic: "damaged items",
    body: "For a damaged item, we replace or refund at no cost. Ask the customer for a photo, then process the resolution.",
  },
];

export function lookupOrder(id: string): Order | null {
  return ORDERS[id.toUpperCase()] ?? null;
}

export function ordersForEmail(email: string): Order[] {
  const e = email.toLowerCase();
  return Object.values(ORDERS).filter((o) => o.email.toLowerCase() === e);
}

export function searchKnowledge(query: string): { topic: string; body: string }[] {
  const q = query.toLowerCase();
  const hits = KNOWLEDGE_BASE.filter(
    (k) =>
      k.topic.includes(q) ||
      q.split(/\s+/).some((w) => w.length > 3 && k.topic.includes(w)),
  );
  return hits.length ? hits : KNOWLEDGE_BASE;
}

/** Records a refund against the in-memory order. Returns the new refunded total. */
export function applyRefund(id: string, amountCents: number): Order {
  const order = lookupOrder(id);
  if (!order) throw new Error(`No such order: ${id}`);
  if (amountCents <= 0) throw new Error("Refund amount must be positive.");
  if (order.refundedCents + amountCents > order.amountCents) {
    throw new Error("Refund would exceed the order total.");
  }
  order.refundedCents += amountCents;
  return order;
}
