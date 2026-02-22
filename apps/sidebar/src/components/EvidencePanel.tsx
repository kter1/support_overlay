/**
 * @file apps/sidebar/src/components/EvidencePanel.tsx
 * @description Detailed evidence panel — shown in progressive disclosure.
 * Non-accusatory language throughout.
 */

import React from "react";

interface EvidencePanelProps {
  evidenceSummary: Record<string, unknown>;
  matchBand: string | null;
  confidenceScore: number | null;
  isSourceUnavailable: boolean;
}

export default function EvidencePanel({
  evidenceSummary,
  matchBand,
  confidenceScore,
  isSourceUnavailable,
}: EvidencePanelProps) {
  return (
    <div style={styles.panel}>
      <div style={styles.sectionTitle}>Evidence Detail</div>

      {isSourceUnavailable && (
        <div style={styles.unavailableNote}>
          Source record is no longer available. Showing last known state.
        </div>
      )}

      <div style={styles.grid}>
        {/* Stripe Evidence */}
        {evidenceSummary.stripeRefundId && (
          <DetailBlock
            title="Stripe Refund"
            items={[
              ["ID", String(evidenceSummary.stripeRefundId)],
              ["Status", String(evidenceSummary.stripeRefundStatus ?? "—")],
              ["Amount", formatCents(evidenceSummary.stripeChargeAmount as number | undefined, evidenceSummary.stripeCurrency as string | undefined)],
            ]}
          />
        )}

        {/* Shopify Evidence */}
        {evidenceSummary.shopifyOrderId && (
          <DetailBlock
            title="Shopify Order"
            items={[
              ["Order", String(evidenceSummary.shopifyOrderName ?? evidenceSummary.shopifyOrderId)],
              ["Financial", String(evidenceSummary.shopifyFinancialStatus ?? "—")],
              ["Fulfillment", String(evidenceSummary.shopifyFulfillmentStatus ?? "—")],
              ["Total", formatCents(evidenceSummary.shopifyOrderTotal as number | undefined, evidenceSummary.shopifyOrderCurrency as string | undefined)],
            ]}
          />
        )}
      </div>

      {/* Match result */}
      {matchBand && (
        <div style={styles.matchRow}>
          <span style={styles.matchLabel}>Match result</span>
          <span style={{
            ...styles.matchValue,
            color: matchBand === "HIGH" || matchBand === "EXACT" ? "#137333" :
                   matchBand === "MEDIUM" ? "#7a4f00" : "#a50e0e",
          }}>
            {matchBand}
            {confidenceScore !== null && ` (${Math.round(confidenceScore * 100)}%)`}
          </span>
        </div>
      )}
    </div>
  );
}

function DetailBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div style={styles.detailBlock}>
      <div style={styles.detailTitle}>{title}</div>
      {items.map(([label, value]) => (
        <div key={label} style={styles.detailRow}>
          <span style={styles.detailLabel}>{label}</span>
          <span style={styles.detailValue}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function formatCents(cents?: number, currency?: string): string {
  if (cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format(cents / 100);
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: "12px 16px",
    borderBottom: "1px solid #f0f0f0",
    background: "#f8f9fa",
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#68737d",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  unavailableNote: {
    fontSize: 11,
    color: "#7a4f00",
    background: "#fff8e1",
    padding: "6px 8px",
    borderRadius: 4,
    marginBottom: 10,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginBottom: 10,
  },
  detailBlock: {
    background: "white",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    padding: "8px 10px",
  },
  detailTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#2f3941",
    marginBottom: 6,
    paddingBottom: 4,
    borderBottom: "1px solid #f0f0f0",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  detailLabel: { fontSize: 11, color: "#68737d" },
  detailValue: { fontSize: 11, fontWeight: 500, color: "#2f3941" },
  matchRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 0",
    borderTop: "1px solid #e8eaed",
    marginTop: 4,
  },
  matchLabel: { fontSize: 12, color: "#68737d" },
  matchValue: { fontSize: 12, fontWeight: 600 },
};
