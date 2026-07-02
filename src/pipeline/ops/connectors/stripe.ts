import type { OpsConnector, ConnectorConfig } from "./base.js";
import type { DataSnapshot } from "../schema.js";

export class StripeConnector implements OpsConnector {
  constructor(readonly id: string) {}

  async fetch(cfg: ConnectorConfig): Promise<Partial<DataSnapshot>> {
    const apiKey = cfg.credentials?.STRIPE_API_KEY || process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error(`Stripe API key is not configured for connector ${this.id}`);
    }

    const authHeader = "Basic " + Buffer.from(apiKey + ":").toString("base64");

    const get = async (path: string) => {
      const res = await fetch(`https://api.stripe.com${path}`, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Stripe API error GET ${path}: HTTP ${res.status} - ${text}`);
      }
      return res.json() as Promise<any>;
    };

    const snapshot: Partial<DataSnapshot> = {
      customers: [],
      subscription_events: [],
      payments: [],
    };

    // 1. Fetch Customers
    const customersData = await get("/v1/customers?limit=100");
    const stripeCustomers = customersData.data || [];
    for (const c of stripeCustomers) {
      const cohortDate = new Date((c.created || Date.now() / 1000) * 1000);
      const cohortMonth = `${cohortDate.getFullYear()}-${String(cohortDate.getMonth() + 1).padStart(2, "0")}`;
      snapshot.customers!.push({
        id: c.id,
        name: c.name || c.description || c.email || `Customer ${c.id}`,
        cohortMonth,
      });
    }

    // 2. Fetch Charges
    const chargesData = await get("/v1/charges?limit=100");
    const stripeCharges = chargesData.data || [];
    for (const ch of stripeCharges) {
      const chargeDate = new Date((ch.created || Date.now() / 1000) * 1000);
      const dateStr = chargeDate.toISOString().slice(0, 10);
      snapshot.payments!.push({
        id: ch.id,
        invoiceId: ch.invoice || ch.payment_intent || `inv_${ch.id}`,
        amount: (ch.amount || 0) / 100, // Stripe amounts are in cents
        currency: (ch.currency || "usd").toUpperCase(),
        paymentDate: dateStr,
        status: ch.status || (ch.paid ? "success" : "failed"),
      });
    }

    // 3. Fetch Subscriptions / Events
    try {
      const eventsData = await get("/v1/events?limit=100&type=customer.subscription.*");
      const stripeEvents = eventsData.data || [];
      for (const ev of stripeEvents) {
        const evDate = new Date((ev.created || Date.now() / 1000) * 1000);
        const dateStr = evDate.toISOString().slice(0, 10);
        const subObj = ev.data?.object;
        if (!subObj) continue;

        let type: "signup" | "renew" | "churn" = "signup";
        if (ev.type === "customer.subscription.deleted") {
          type = "churn";
        } else if (ev.type === "customer.subscription.updated") {
          type = "renew";
        }

        const value = (subObj.plan?.amount || subObj.items?.data?.[0]?.plan?.amount || 0) / 100;

        snapshot.subscription_events!.push({
          id: ev.id,
          customerId: subObj.customer,
          type,
          monthlyValue: value,
          eventDate: dateStr,
        });
      }
    } catch {
      // Fallback: parse direct subscriptions
      const subsData = await get("/v1/subscriptions?status=all&limit=100");
      const stripeSubs = subsData.data || [];
      for (const sub of stripeSubs) {
        const createdDate = new Date((sub.created || Date.now() / 1000) * 1000);
        const createdStr = createdDate.toISOString().slice(0, 10);
        const value = (sub.plan?.amount || sub.items?.data?.[0]?.plan?.amount || 0) / 100;
        
        snapshot.subscription_events!.push({
          id: `sub_evt_${sub.id}_signup`,
          customerId: sub.customer,
          type: "signup",
          monthlyValue: value,
          eventDate: createdStr,
        });

        if (sub.status === "canceled" && sub.canceled_at) {
          const cancelDate = new Date(sub.canceled_at * 1000);
          snapshot.subscription_events!.push({
            id: `sub_evt_${sub.id}_churn`,
            customerId: sub.customer,
            type: "churn",
            monthlyValue: value,
            eventDate: cancelDate.toISOString().slice(0, 10),
          });
        }
      }
    }

    return snapshot;
  }
}
