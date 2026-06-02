import type { ToolDef } from "../../types.js";
import {
  applyRefund,
  lookupOrder,
  ordersForEmail,
  searchKnowledge,
} from "./backend.js";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const searchKbTool: ToolDef<{ query: string }> = {
  name: "search_knowledge_base",
  description:
    "Search the support knowledge base for policy and how-to articles. Use this before answering policy questions (returns, shipping, damages) so your answer matches company policy.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up, e.g. 'refund window'." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: ({ query }) => {
    const hits = searchKnowledge(query);
    return {
      content: hits.map((h) => `## ${h.topic}\n${h.body}`).join("\n\n"),
    };
  },
};

export const getOrderTool: ToolDef<{ orderId: string }> = {
  name: "get_order",
  description: "Look up a single order by its id (for example A-1001).",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order id." },
    },
    required: ["orderId"],
    additionalProperties: false,
  },
  run: ({ orderId }) => {
    const o = lookupOrder(orderId);
    if (!o) return { content: `No order found with id ${orderId}.`, isError: true };
    return {
      content: JSON.stringify(
        {
          id: o.id,
          item: o.item,
          status: o.status,
          total: usd(o.amountCents),
          refunded: usd(o.refundedCents),
          placedAt: o.placedAt,
          email: o.email,
        },
        null,
        2,
      ),
    };
  },
};

export const findOrdersTool: ToolDef<{ email: string }> = {
  name: "find_orders_by_email",
  description: "Find all orders placed by a customer, given their email address.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Customer email." },
    },
    required: ["email"],
    additionalProperties: false,
  },
  run: ({ email }) => {
    const orders = ordersForEmail(email);
    if (!orders.length) return { content: `No orders found for ${email}.` };
    return {
      content: orders
        .map((o) => `${o.id}: ${o.item} (${o.status}, ${usd(o.amountCents)})`)
        .join("\n"),
    };
  },
};

export const issueRefundTool: ToolDef<{
  orderId: string;
  amountCents: number;
  reason: string;
}> = {
  name: "issue_refund",
  // Sensitive: it moves money and is hard to reverse, so it is gated for approval.
  description:
    "Issue a refund against an order. This moves money and cannot be undone, so it requires approval. Only call it once you have confirmed the order and that a refund is warranted by policy.",
  risk: "sensitive",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order to refund." },
      amountCents: {
        type: "integer",
        description: "Refund amount in cents.",
      },
      reason: { type: "string", description: "Why the refund is being issued." },
    },
    required: ["orderId", "amountCents", "reason"],
    additionalProperties: false,
  },
  run: ({ orderId, amountCents }) => {
    const order = applyRefund(orderId, amountCents);
    return {
      content: `Refund of ${usd(amountCents)} applied to ${order.id}. Refunded total is now ${usd(
        order.refundedCents,
      )} of ${usd(order.amountCents)}.`,
    };
  },
};

export const sendReplyTool: ToolDef<{ message: string }> = {
  name: "send_reply",
  // Write: it is customer-facing, so it is gated before anything is sent.
  description:
    "Send your reply to the customer. This is the only way the customer sees your message, so call it once with your complete, final response.",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The full reply to the customer." },
    },
    required: ["message"],
    additionalProperties: false,
  },
  run: ({ message }) => {
    return { content: `Reply sent to customer:\n${message}` };
  },
};
