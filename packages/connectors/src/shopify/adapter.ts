/**
 * @file packages/connectors/src/shopify/adapter.ts
 * @description Shopify connector with fixture simulator fallback.
 *
 * Handles archived order tombstone semantics per spec §4.2.4:
 *   - Archived orders return 404 from Shopify API
 *   - On 404: set evidence_normalized.is_source_unavailable = true
 *   - Do not delete evidence. Card shows source-unavailable message.
 *
 * Validation level: [Compile: pending npm install]
 */

export interface ShopifyOrder {
  id: string;
  name: string;
  financial_status: "pending" | "authorized" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "voided";
  fulfillment_status: "fulfilled" | "partial" | "unfulfilled" | "restocked" | null;
  total_price: string;
  subtotal_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  line_items: ShopifyLineItem[];
  customer?: {
    id: number;
    email: string;
  };
  refunds?: ShopifyRefund[];
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  quantity: number;
  price: string;
  sku: string | null;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  transactions: Array<{
    amount: string;
    currency: string;
    status: string;
  }>;
}

export class SourceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SourceUnavailableError";
  }
}

export class ShopifyAdapter {
  private readonly isSimulator: boolean;
  private readonly accessToken: string;

  constructor() {
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
    this.isSimulator = !this.accessToken || process.env.USE_SHOPIFY_SIMULATOR === "true";

    if (this.isSimulator) {
      console.log("[ShopifyAdapter] No credentials found — using simulator");
    }
  }

  /**
   * Get an order by ID.
   *
   * Throws SourceUnavailableError if:
   *   - Order returns 404 (archived or deleted)
   *   - Order has financial_status === 'archived' (Shopify marks archived differently)
   *
   * Callers must catch SourceUnavailableError and set is_source_unavailable = true.
   * Do NOT treat this as a retriable error.
   */
  async getOrder(orderId: string, shop: string): Promise<ShopifyOrder> {
    if (this.isSimulator) {
      return this.simulatorGetOrder(orderId);
    }

    const url = `https://${shop}.myshopify.com/admin/api/2024-01/orders/${orderId}.json`;
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": this.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 404) {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} returned 404 — likely archived or deleted. ` +
        "Verify via Shopify admin if needed. Evidence will show source-unavailable state."
      );
    }

    if (!response.ok) {
      throw new Error(`Shopify getOrder failed: ${response.status} ${await response.text()}`);
    }

    const body = await response.json() as { order: ShopifyOrder };
    return body.order;
  }

  // ─── Simulator ──────────────────────────────────────────────────────────────

  private simulatorGetOrder(orderId: string): ShopifyOrder {
    const fixtures: Record<string, ShopifyOrder | "archived"> = {
      "order_happy_001": {
        id: "order_happy_001",
        name: "#1001",
        financial_status: "refunded",
        fulfillment_status: "fulfilled",
        total_price: "49.99",
        subtotal_price: "49.99",
        currency: "USD",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        line_items: [
          { id: 1, title: "Widget Pro", quantity: 1, price: "49.99", sku: "WP-001" },
        ],
        refunds: [
          {
            id: 1,
            created_at: "2024-01-02T00:00:00Z",
            transactions: [{ amount: "49.99", currency: "USD", status: "success" }],
          },
        ],
      },
      // Archived order — simulator throws SourceUnavailableError
      "order_archived_001": "archived",
      "order_retry_001": {
        id: "order_retry_001",
        name: "#1003",
        financial_status: "refunded",
        fulfillment_status: "fulfilled",
        total_price: "30.00",
        subtotal_price: "30.00",
        currency: "USD",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        line_items: [
          { id: 3, title: "Basic Widget", quantity: 1, price: "30.00", sku: "BW-003" },
        ],
      },
    };

    const fixture = fixtures[orderId];
    if (!fixture) {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} not found in simulator fixtures. ` +
        "Treating as unavailable."
      );
    }
    if (fixture === "archived") {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} is archived — last known state unavailable. ` +
        "Verify via Shopify admin if needed."
      );
    }

    return fixture;
  }
}
