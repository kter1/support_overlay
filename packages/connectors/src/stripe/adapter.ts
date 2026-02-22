/**
 * @file packages/connectors/src/stripe/adapter.ts
 * @description Stripe connector with fixture simulator fallback.
 *
 * When STRIPE_API_KEY is not set (local demo default), uses the simulator.
 * All simulator responses mirror real Stripe API shapes exactly.
 *
 * Retry classification (spec §4.2.3):
 *   - stripe_refund_check: RECONCILIATION_FIRST (read before any retry)
 *   - initiate_stripe_refund: OPERATOR_RETRY_ONLY (never auto-retry — money movement)
 *
 * Validation level: [Compile: pending npm install]
 */

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed" | "canceled";
  charge: string;
  created: number;
  reason: string | null;
  failure_reason?: string;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  refunded: boolean;
  amount_refunded: number;
  created: number;
}

export class StripeAdapter {
  private readonly isSimulator: boolean;
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.STRIPE_API_KEY ?? "";
    this.isSimulator = !this.apiKey || process.env.USE_STRIPE_SIMULATOR === "true";

    if (this.isSimulator) {
      console.log("[StripeAdapter] No credentials found — using simulator");
    }
  }

  /**
   * Look up a refund by ID or idempotency key.
   * Used for SENT_UNCERTAIN reconciliation before any retry.
   *
   * Example A (spec §4.2.2.3 Example C):
   *   If SENT_UNCERTAIN: call this first. If found → CONFIRMED. Never re-send.
   */
  async getRefund(refundId: string): Promise<StripeRefund | null> {
    if (this.isSimulator) {
      return this.simulatorGetRefund(refundId);
    }

    const response = await fetch(`https://api.stripe.com/v1/refunds/${refundId}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Stripe getRefund failed: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<StripeRefund>;
  }

  /**
   * List refunds by charge ID. Used for reconciliation when refund ID unknown.
   */
  async listRefundsByCharge(chargeId: string): Promise<StripeRefund[]> {
    if (this.isSimulator) {
      return this.simulatorListRefunds(chargeId);
    }

    const url = `https://api.stripe.com/v1/refunds?charge=${chargeId}&limit=10`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Stripe listRefunds failed: ${response.status}`);
    }

    const body = await response.json() as { data: StripeRefund[] };
    return body.data;
  }

  /**
   * Get a charge by ID.
   */
  async getCharge(chargeId: string): Promise<StripeCharge | null> {
    if (this.isSimulator) {
      return this.simulatorGetCharge(chargeId);
    }

    const response = await fetch(`https://api.stripe.com/v1/charges/${chargeId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Stripe getCharge failed: ${response.status}`);
    }

    return response.json() as Promise<StripeCharge>;
  }

  // ─── Simulator ──────────────────────────────────────────────────────────────
  // Fixture-based simulator. Mirrors real Stripe API response shapes.

  private simulatorGetRefund(refundId: string): StripeRefund | null {
    const fixtures: Record<string, StripeRefund> = {
      "re_happy_001": {
        id: "re_happy_001",
        object: "refund",
        amount: 4999,
        currency: "usd",
        status: "succeeded",
        charge: "ch_001",
        created: 1704067200,
        reason: null,
      },
      "re_degraded_001": {
        id: "re_degraded_001",
        object: "refund",
        amount: 7500,
        currency: "usd",
        status: "pending",
        charge: "ch_002",
        created: 1704067200,
        reason: null,
      },
      "re_retry_001": {
        id: "re_retry_001",
        object: "refund",
        amount: 3000,
        currency: "usd",
        status: "succeeded",
        charge: "ch_003",
        created: 1704067200,
        reason: null,
      },
    };

    return fixtures[refundId] ?? null;
  }

  private simulatorListRefunds(chargeId: string): StripeRefund[] {
    const byCharge: Record<string, StripeRefund[]> = {
      "ch_001": [this.simulatorGetRefund("re_happy_001")!],
      "ch_002": [this.simulatorGetRefund("re_degraded_001")!],
      "ch_003": [this.simulatorGetRefund("re_retry_001")!],
    };
    return byCharge[chargeId] ?? [];
  }

  private simulatorGetCharge(chargeId: string): StripeCharge | null {
    const fixtures: Record<string, StripeCharge> = {
      "ch_001": { id: "ch_001", object: "charge", amount: 4999, currency: "usd", status: "succeeded", refunded: true, amount_refunded: 4999, created: 1704000000 },
      "ch_002": { id: "ch_002", object: "charge", amount: 7500, currency: "usd", status: "succeeded", refunded: false, amount_refunded: 0, created: 1704000000 },
      "ch_003": { id: "ch_003", object: "charge", amount: 3000, currency: "usd", status: "succeeded", refunded: true, amount_refunded: 3000, created: 1704000000 },
    };
    return fixtures[chargeId] ?? null;
  }
}
