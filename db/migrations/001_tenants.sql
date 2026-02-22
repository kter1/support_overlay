-- IISL Phase 1 — Migration 001
-- Core tenancy and configuration tables
-- VALIDATION: [COMPILE-PENDING] — run via: npm run migrate (requires Postgres)
-- Spec reference: Section 2.1, 2.2

-- ─── Tenants ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,          -- URL-safe identifier
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Tenant Config ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_config (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evidence_freshness_secs         INT NOT NULL DEFAULT 300,
  amount_match_tolerance_pct      NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  reopen_gate_count               INT NOT NULL DEFAULT 3,
  manager_approval_threshold_cents INT NOT NULL DEFAULT 5000,
  -- Approval toggle: false by default for pilot.
  -- When false: policy engine must NOT return REQUIRES_APPROVAL.
  -- When true: full approval lifecycle runs as specified.
  approvals_enabled               BOOLEAN NOT NULL DEFAULT false,
  manager_approval_group_id       TEXT,         -- Zendesk group ID; nullable
  macro_prefix_resolved           TEXT NOT NULL DEFAULT '',
  macro_prefix_pending            TEXT NOT NULL DEFAULT '',
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ─── Tenant Integrations ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_system   TEXT NOT NULL CHECK (source_system IN ('zendesk', 'stripe', 'shopify')),
  -- Credentials stored as AES-256 encrypted blob (key management out of scope for pilot demo)
  credentials     JSONB NOT NULL DEFAULT '{}',
  webhook_secret  TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system)
);
