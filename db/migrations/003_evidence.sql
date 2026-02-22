-- IISL Phase 1 — Migration 003
-- Evidence model: raw snapshots, normalized, match results, read model
-- VALIDATION: [COMPILE-PENDING]
-- Spec reference: Section 2.4, Section 2.5

-- ─── Evidence Raw Snapshots ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evidence_raw_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  issue_id        UUID NOT NULL REFERENCES issues(id),
  source_system   TEXT NOT NULL CHECK (source_system IN ('zendesk', 'stripe', 'shopify')),
  source_record_id TEXT NOT NULL,             -- e.g. Stripe refund ID, Shopify order ID
  normalizer_version TEXT NOT NULL,
  -- raw_data nullable: nulled after 90-day retention window or on GDPR erasure
  raw_data                  JSONB,
  raw_data_redacted_at      TIMESTAMPTZ,
  raw_data_redaction_reason TEXT,             -- 'retention_90d' | 'gdpr_erasure'
  raw_data_hash             TEXT,             -- SHA-256 of original, preserved post-redaction
  fetched_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_raw_issue ON evidence_raw_snapshots (tenant_id, issue_id, source_system);

-- ─── Evidence Normalized ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evidence_normalized (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  issue_id              UUID NOT NULL REFERENCES issues(id),
  raw_snapshot_id       UUID NOT NULL REFERENCES evidence_raw_snapshots(id),
  source_system         TEXT NOT NULL CHECK (source_system IN ('zendesk', 'stripe', 'shopify')),
  normalizer_version    TEXT NOT NULL,
  -- Refund-specific normalized fields (Refund Playbook v1)
  refund_status         TEXT CHECK (refund_status IN ('succeeded', 'pending', 'failed', 'not_found')),
  refund_amount_cents   INT,
  refund_currency       TEXT,
  refund_id             TEXT,                 -- provider refund ID
  order_id              TEXT,
  order_amount_cents    INT,
  -- Time-based freshness: computed at read time from fetched_at vs config.
  -- is_source_unavailable is a SEPARATE persisted flag for tombstone/archival state.
  -- Do NOT conflate time-based freshness with source unavailability.
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Persisted source-unavailability flag (NOT time-based freshness)
  -- Set when source record is archived, deleted, merged, or permanently unreachable.
  is_source_unavailable BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_norm_issue ON evidence_normalized (tenant_id, issue_id, source_system);

-- ─── Evidence Match Results ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evidence_match_results (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID NOT NULL REFERENCES issues(id),
  evidence_normalized_id  UUID NOT NULL REFERENCES evidence_normalized(id),
  match_algorithm_version TEXT NOT NULL,
  match_band              TEXT NOT NULL
    CHECK (match_band IN ('EXACT', 'HIGH', 'MEDIUM', 'LOW', 'NO_MATCH')),
  confidence_score        NUMERIC(5,2) NOT NULL,     -- 0.00 to 100.00
  match_details           JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_results_issue ON evidence_match_results (tenant_id, issue_id);

-- ─── Issue Card State (Denormalized Read Model) ───────────────────────────────

-- Derived cache. May be rebuilt at any time from canonical tables.
-- No application code may read from this before writing to canonical tables.
-- All canonical writes (state_transitions, action_executions, audit_log) complete first.

CREATE TABLE IF NOT EXISTS issue_card_state (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID NOT NULL REFERENCES issues(id) UNIQUE,
  zendesk_ticket_id       TEXT,
  issue_state             TEXT NOT NULL,
  -- Evidence summary (denormalized for fast card render)
  refund_status           TEXT,
  refund_amount_cents     INT,
  refund_currency         TEXT,
  refund_id               TEXT,
  match_band              TEXT,
  confidence_score        NUMERIC(5,2),
  evidence_fetched_at     TIMESTAMPTZ,
  -- Source availability (persisted flag, not freshness computation)
  is_source_unavailable   BOOLEAN NOT NULL DEFAULT false,
  -- Pending action state
  pending_action_type     TEXT,
  pending_action_status   TEXT,
  pending_execution_id    UUID,
  pending_approval_id     UUID,
  -- Card metadata
  last_rebuilt_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_state_tenant ON issue_card_state (tenant_id);
CREATE INDEX idx_card_state_ticket ON issue_card_state (zendesk_ticket_id)
  WHERE zendesk_ticket_id IS NOT NULL;
