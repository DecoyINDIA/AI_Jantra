import type { OpsConnector } from "./base.js";
import { CsvConnector } from "./csv.js";
import { StripeConnector } from "./stripe.js";
import { ShopifyConnector } from "./shopify.js";

class ConnectorRegistry {
  private readonly connectors = new Map<string, (id: string) => OpsConnector>();

  constructor() {
    this.register("csv", (id) => new CsvConnector(id));
    this.register("stripe", (id) => new StripeConnector(id));
    this.register("shopify", (id) => new ShopifyConnector(id));
  }

  register(type: string, factory: (id: string) => OpsConnector): void {
    this.connectors.set(type, factory);
  }

  get(type: string, id: string): OpsConnector {
    const factory = this.connectors.get(type);
    if (!factory) {
      throw new Error(`Unsupported connector type: ${type}`);
    }
    return factory(id);
  }
}

export const defaultConnectorRegistry = new ConnectorRegistry();
export type { OpsConnector };
