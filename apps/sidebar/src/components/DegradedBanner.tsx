/**
 * @file apps/sidebar/src/components/DegradedBanner.tsx
 * Non-accusatory banner for degraded mode states.
 * Spec §9: no accusation language. Source unavailable ≠ fraud signal.
 */

import React from "react";

interface DegradedBannerProps {
  isSourceUnavailable: boolean;
  sourceUnavailableReason: string | null;
  freshnessStatus: string;
  evidenceFetchedAt: string | null;
}

export default function DegradedBanner({
  isSourceUnavailable,
  sourceUnavailableReason,
  freshnessStatus,
  evidenceFetchedAt,
}: DegradedBannerProps) {
  if (isSourceUnavailable) {
    return (
      <div style={styles.unavailableBanner}>
        <span style={styles.icon}>📋</span>
        <div>
          <div style={styles.title}>Source record no longer available — case record preserved</div>
          {sourceUnavailableReason && (
            <div style={styles.detail}>{sourceUnavailableReason}</div>
          )}
        </div>
      </div>
    );
  }

  if (freshnessStatus === "STALE") {
    const age = evidenceFetchedAt
      ? Math.round((Date.now() - new Date(evidenceFetchedAt).getTime()) / 60000)
      : null;

    return (
      <div style={styles.staleBanner}>
        <span style={styles.icon}>🕐</span>
        <div>
          <div style={styles.title}>Evidence may not reflect the latest state</div>
          <div style={styles.detail}>
            {age !== null ? `Last fetched ${age}m ago.` : "Last fetch time unknown."}{" "}
            Consider refreshing before taking action.
          </div>
        </div>
      </div>
    );
  }

  return null;
}

const styles: Record<string, React.CSSProperties> = {
  unavailableBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 16px",
    background: "#f5f0ff",
    borderBottom: "1px solid #d4c5f9",
  },
  staleBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 16px",
    background: "#fff8e1",
    borderBottom: "1px solid #f0c040",
  },
  icon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
  title: { fontSize: 12, fontWeight: 500, color: "#2f3941", marginBottom: 2 },
  detail: { fontSize: 11, color: "#68737d", lineHeight: 1.4 },
};
