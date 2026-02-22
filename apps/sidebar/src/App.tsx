/**
 * @file apps/sidebar/src/App.tsx
 * @description Root application — local demo mock of Zendesk sidebar.
 *
 * In production, this would be embedded via the Zendesk Apps Framework (ZAF)
 * and receive the current ticket ID from the ZAF client. For local demo,
 * we provide a ticket selector to simulate the sidebar in context.
 */

import React, { useState } from "react";
import ResolutionCard from "./components/ResolutionCard";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

const DEMO_TICKETS = [
  { id: "10001", label: "Scenario 1: Happy Path — Refund Confirmed", emoji: "✅" },
  { id: "10002", label: "Scenario 2: Degraded — Source Unavailable", emoji: "⚠️" },
  { id: "10003", label: "Scenario 3: Retry + Unknown Outcome", emoji: "🔄" },
];

export default function App() {
  const [selectedTicket, setSelectedTicket] = useState<string>("10001");
  const [agentId] = useState("agent-demo-001");

  return (
    <div style={{ display: "flex", gap: 0, minHeight: "100vh" }}>
      {/* Left: Demo ticket selector (simulates Zendesk context) */}
      <div style={{
        width: 280,
        background: "#1f73b7",
        color: "white",
        padding: "20px 16px",
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 1, marginBottom: 16 }}>
          DEMO — TICKET SELECTOR
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 20, lineHeight: 1.4 }}>
          In production, this sidebar is embedded in Zendesk and receives the
          current ticket ID from the ZAF client automatically.
        </div>
        {DEMO_TICKETS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedTicket(t.id)}
            style={{
              display: "block",
              width: "100%",
              background: selectedTicket === t.id ? "rgba(255,255,255,0.2)" : "transparent",
              border: selectedTicket === t.id ? "1px solid rgba(255,255,255,0.5)" : "1px solid transparent",
              borderRadius: 6,
              color: "white",
              padding: "10px 12px",
              textAlign: "left",
              cursor: "pointer",
              marginBottom: 8,
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            <div style={{ fontSize: 18, marginBottom: 4 }}>{t.emoji}</div>
            <div>#{t.id}</div>
            <div style={{ opacity: 0.8, fontSize: 11, marginTop: 2 }}>{t.label}</div>
          </button>
        ))}

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.2)" }}>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>Approval Toggle Demo</div>
          <a
            href={`${API_BASE}/ops/tenants/00000000-0000-0000-0000-000000000001/config`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "rgba(255,255,255,0.8)", fontSize: 11 }}
          >
            Manage config via API →
          </a>
        </div>
      </div>

      {/* Right: Resolution Card (the actual sidebar UI) */}
      <div style={{ flex: 1, maxWidth: 400, background: "#f8f9fa" }}>
        {/* Simulated Zendesk sidebar header */}
        <div style={{
          background: "white",
          borderBottom: "1px solid #e0e0e0",
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: 4,
            background: "#1f73b7",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: "white", fontSize: 12, fontWeight: 700 }}>R</span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#2f3941" }}>Resolution Card</span>
          <span style={{ fontSize: 11, color: "#68737d", marginLeft: "auto" }}>
            Ticket #{selectedTicket}
          </span>
        </div>

        <ResolutionCard
          zendeskTicketId={selectedTicket}
          agentId={agentId}
        />
      </div>
    </div>
  );
}
