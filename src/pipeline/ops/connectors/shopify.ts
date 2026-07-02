import type { OpsConnector, ConnectorConfig } from "./base.js";
import type { DataSnapshot } from "../schema.js";

export class ShopifyConnector implements OpsConnector {
  constructor(readonly id: string) {}

  async fetch(cfg: ConnectorConfig): Promise<Partial<DataSnapshot>> {
    const shopName = cfg.credentials?.SHOPIFY_SHOP_NAME || cfg.config.shopName || process.env.SHOPIFY_SHOP_NAME;
    const accessToken = cfg.credentials?.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;

    if (!shopName || !accessToken) {
      throw new Error(`Shopify shopName or accessToken is not configured for connector ${this.id}`);
    }

    const get = async (path: string) => {
      const res = await fetch(`https://${shopName}.myshopify.com${path}`, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Shopify API error GET ${path}: HTTP ${res.status} - ${text}`);
      }
      return res.json() as Promise<any>;
    };

    const snapshot: Partial<DataSnapshot> = {
      orders: [],
      order_lines: [],
      products: [],
      customers: [],
    };

    // 1. Fetch Products
    const productsData = await get("/admin/api/2024-04/products.json?limit=100");
    const shopifyProducts = productsData.products || [];
    for (const p of shopifyProducts) {
      snapshot.products!.push({
        id: String(p.id),
        name: p.title,
        category: p.product_type || "General",
        sku: p.variants?.[0]?.sku || undefined,
      });
    }

    // 2. Fetch Orders
    const ordersData = await get("/admin/api/2024-04/orders.json?status=any&limit=100");
    const shopifyOrders = ordersData.orders || [];
    for (const ord of shopifyOrders) {
      const orderDate = (ord.created_at || new Date().toISOString()).slice(0, 10);
      const orderId = String(ord.id);
      
      let customerId = "guest";
      if (ord.customer) {
        customerId = String(ord.customer.id);
        const cohortDate = new Date(ord.customer.created_at || ord.created_at || Date.now());
        const cohortMonth = `${cohortDate.getFullYear()}-${String(cohortDate.getMonth() + 1).padStart(2, "0")}`;
        
        // Add to customers if not exists
        if (!snapshot.customers!.some(c => c.id === customerId)) {
          snapshot.customers!.push({
            id: customerId,
            name: `${ord.customer.first_name || ""} ${ord.customer.last_name || ""}`.trim() || `Customer ${customerId}`,
            cohortMonth,
          });
        }
      }

      // Add lines
      const lineItems = ord.line_items || [];
      for (const item of lineItems) {
        snapshot.order_lines!.push({
          id: String(item.id),
          orderId,
          productId: String(item.product_id),
          amount: Number(item.price) * (item.quantity || 1),
          quantity: item.quantity || 1,
        });

        // Add main order header (Shopify total is ord.total_price, but let's record per product order line matching Jantra rules)
        snapshot.orders!.push({
          id: `${orderId}_${item.id}`,
          customerId,
          productId: String(item.product_id),
          channelId: "shopify",
          amount: Number(item.price) * (item.quantity || 1),
          currency: (ord.currency || "USD").toUpperCase(),
          orderDate,
          quantity: item.quantity || 1,
        });
      }
    }

    return snapshot;
  }
}
