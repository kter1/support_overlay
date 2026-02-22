-- ============================================================================
-- IISL Phase 1 — Master Schema Migration
-- Spec: v1.1.3
-- Generated: [Runtime pending local Postgres]
--
-- Run order: this single file creates all tables in dependency order.
-- For incremental migrations, split at the section markers.
--
-- Schema authority note (spec §2):
--   This file IS the canonical migration source of truth.
--   If this file diverges from the spec DDL section, this file wins.
--   Update the spec within one week of any schema change.
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Tenants ─────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  subdomain    TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Tenant Config ────────────────────────────────────────────────────────────

CREATE TABLE tenant_config (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL REFERENCES tenants(id),
  -- Approval toggle — OFF by default for all pilot tenants (spec build req §8)
  -- If false: policy engine MUST NOT return REQUIRES_APPROVAL
  approvals_enabled               BOOLEAN NOT NULL DEFAULT false,
  evidence_freshness_seconds      INT NOT NULL DEFAULT 300,
  refund_amount_tolerance_pct     NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  reopen_gate_count               INT NOT NULL DEFAULT 3,
  manager_approval_threshold_cents INT NOT NULL DEFAULT 5000,
  -- manager_approval_group_id: normalized name (spec Finding 8)
  manager_approval_group_id       TEXT,
  zendesk_subdomain               TEXT,
  zendesk_agent_group_id          TEXT,
  macro_prefix_resolved           TEXT NOT NULL DEFAULT '',
  macro_prefix_pending            TEXT NOT NULL DEFAULT '',
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ─── Tenant Integrations ─────────────────────────────────────────────────────

CREATE TABLE tenant_integrations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  source_system  TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  credentials    JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  use_simulator  BOOLEAN NOT NULL DEFAULT true,  -- true = use fixture adapter
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system)
);

-- ─── Issues ───────────────────────────────────────────────────────────────────

CREATE TABLE issues (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  -- customer_id and customer_email nullable: nulled on GDPR/CCPA erasure (spec Finding 4)
  customer_id    TEXT,
  customer_email TEXT,
  state          TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN','PENDING_EVIDENCE','PENDING_APPROVAL','ACTION_IN_PROGRESS',
                     'RESOLVED','ESCALATED','NEEDS_REVIEW')),
  -- lock_version: optimistic concurrency control for state writes
  lock_version   INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_issues_tenant_state ON issues (tenant_id, state);
CREATE INDEX idx_issues_tenant_customer ON issues (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

-- ─── Issue Tickets ────────────────────────────────────────────────────────────

CREATE TABLE issue_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  issue_id           UUID NOT NULL REFERENCES issues(id),
  zendesk_ticket_id  TEXT NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT false,
  -- is_deleted: set true when Zendesk ticket is deleted (spec Finding 12)
  -- Metadata row preserved. Issue and evidence are never deleted.
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, zendesk_ticket_id)
);

CREATE INDEX idx_issue_tickets_active ON issue_tickets (tenant_id, is_deleted)
  WHERE is_deleted = false;
CREATE INDEX idx_issue_tickets_by_issue ON issue_tickets (issue_id);

-- ─── Evidence: Raw Snapshots ──────────────────────────────────────────────────

CREATE TABLE evidence_raw_snapshots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  issue_id                 UUID NOT NULL REFERENCES issues(id),
  source_system            TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  source_record_id         TEXT NOT NULL,
  normalizer_version       TEXT NOT NULL,
  -- raw_data nullable: nulled after 90-day retention or GDPR erasure (spec Finding 4)
  raw_data                 JSONB,
  raw_data_redacted_at     TIMESTAMPTZ,
  raw_data_redaction_reason TEXT,  -- 'retention_90d' | 'gdpr_erasure'
  raw_data_hash            TEXT,   -- SHA-256 of original, preserved post-redaction
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_raw_by_issue ON evidence_raw_snapshots (tenant_id, issue_id);

-- ─── Evidence: Normalized ─────────────────────────────────────────────────────

CREATE TABLE evidence_normalized (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID NOT NULL REFERENCES issues(id),
  source_system             TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  source_record_id          TEXT NOT NULL,
  raw_snapshot_id           UUID NOT NULL REFERENCES evidence_raw_snapshots(id),
  normalizer_version        TEXT NOT NULL,
  normalized_data           JSONB NOT NULL,
  fetched_at                TIMESTAMPTZ NOT NULL,
  -- is_source_unavailable: persisted flag for tombstone/archival/deleted state.
  -- NOT time-based freshness. Time-based freshness computed at read time from
  -- fetched_at vs evidence_freshness_seconds. (spec §4.4, Finding 5)
  is_source_unavailable     BOOLEAN NOT NULL DEFAULT false,
  source_unavailable_reason TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_normalized_issue ON evidence_normalized (tenant_id, issue_id);
CREATE INDEX idx_evidence_normalized_source ON evidence_normalized (tenant_id, source_system, source_record_id);

-- ─── Evidence: Match Results ──────────────────────────────────────────────────

CREATE TABLE evidence_match_results (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID NOT NULL REFERENCES issues(id),
  match_algorithm_version TEXT NOT NULL,
  match_band              TEXT NOT NULL CHECK (match_band IN ('EXACT','HIGH','MEDIUM','LOW','NO_MATCH')),
  confidence_score        NUMERIC(5,4) NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  matched_fields          TEXT[] NOT NULL DEFAULT '{}',
  match_notes             TEXT,  -- Non-accusatory explanation for agents
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_results_issue ON evidence_match_results (tenant_id, issue_id, computed_at DESC);

-- ─── Issue Card State (Read Model) ───────────────────────────────────────────

CREATE TABLE issue_card_state (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      UUID NOT NULL REFERENCES tenants(id),
  issue_id                       UUID NOT NULL REFERENCES issues(id),
  zendesk_ticket_id              TEXT NOT NULL,
  issue_state                    TEXT NOT NULL,
  match_band                     TEXT,
  confidence_score               NUMERIC(5,4),
  evidence_fetched_at            TIMESTAMPTZ,
  -- is_source_unavailable mirrors evidence_normalized.is_source_unavailable
  -- NOT a freshness flag; freshness is computed at read time
  is_source_unavailable          BOOLEAN NOT NULL DEFAULT false,
  pending_action_execution_id    UUID,
  last_action_type               TEXT,
  last_action_completed_at       TIMESTAMPTZ,
  pending_approval_request_id    UUID,
  evidence_summary               JSONB,
  last_rebuilt_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  rebuilt_from_action_execution_id UUID,
  UNIQUE (tenant_id, issue_id)
);

CREATE INDEX idx_card_state_ticket ON issue_card_state (tenant_id, zendesk_ticket_id);

-- ─── Inbound Events ───────────────────────────────────────────────────────────

CREATE TABLE inbound_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  source_system         TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  external_event_id     TEXT NOT NULL,
  -- source_event_at: authoritative timestamp from source system (spec Finding 10)
  -- Nullable: not all providers include event timestamp in payload
  source_event_at       TIMESTAMPTZ,
  source_event_type     TEXT,
  -- payload nullable: nulled after 90-day retention (spec Finding 4)
  payload               JSONB,
  payload_redacted_at   TIMESTAMPTZ,
  payload_redaction_reason TEXT,  -- 'retention_90d' | 'gdpr_erasure'
  payload_hash          TEXT,     -- SHA-256 of original payload, preserved post-redaction
  signature_valid       BOOLEAN NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at          TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','DUPLICATE')),
  error                 TEXT,
  correlation_id        TEXT,  -- Links event to downstream action and audit entries
  UNIQUE (tenant_id, source_system, external_event_id)
);

CREATE INDEX idx_inbound_events_status ON inbound_events (tenant_id, status, received_at);
CREATE INDEX idx_inbound_events_source_at ON inbound_events (tenant_id, source_system, source_event_at)
  WHERE source_event_at IS NOT NULL;

-- ─── Approval Requests ────────────────────────────────────────────────────────

CREATE TABLE approval_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID NOT NULL REFERENCES issues(id),
  action_type             TEXT NOT NULL,
  requested_by_agent_id   TEXT NOT NULL,
  -- action_payload: what will be executed when approved
  action_payload          JSONB NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','CANCELLED')),
  policy_rule_id          TEXT NOT NULL,
  policy_version          TEXT NOT NULL,
  reviewed_by_manager_id  TEXT,
  review_notes            TEXT,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_requests_issue ON approval_requests (tenant_id, issue_id, status);
CREATE INDEX idx_approval_requests_pending ON approval_requests (tenant_id, status, expires_at)
  WHERE status = 'PENDING';

-- ─── Action Executions ────────────────────────────────────────────────────────

CREATE TABLE action_executions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  issue_id               UUID NOT NULL REFERENCES issues(id),
  action_type            TEXT NOT NULL,
  requested_by_agent_id  TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL UNIQUE,
  -- planned_state: intended issues.state after this action completes.
  -- NOT written to state_transitions until execution confirms. (spec §4.2 step 2, Finding 3)
  -- On FAILED_TERMINAL: planned_state remains unwritten to state_transitions.
  planned_state          TEXT,
  status                 TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING','IN_PROGRESS','COMPLETED',
      'FAILED_RETRIABLE','FAILED_TERMINAL'
    )),
  result_payload         JSONB,
  error                  TEXT,
  attempt_count          INT NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ,
  policy_rule_id         TEXT,
  policy_version         TEXT,
  -- approval_request_id: links approval to its execution (spec Finding 1)
  approval_request_id    UUID REFERENCES approval_requests(id),
  -- reconciliation metadata: status stays FAILED_TERMINAL; these fields track
  -- manual operator resolution. (spec Finding 7)
  reconciled_at          TIMESTAMPTZ,
  reconciled_by          TEXT,
  reconciliation_outcome TEXT CHECK (reconciliation_outcome IN (
    'CONFIRMED_OCCURRED','CONFIRMED_NOT_OCCURRED','UNKNOWN'
  )),
  correlation_id         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ
);

-- Partial unique index: each approval maps to at most one execution (spec Finding 1)
-- Enforces the approval→execution 1:1 idempotency invariant at schema level.
CREATE UNIQUE INDEX uix_action_executions_approval
  ON action_executions (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

CREATE INDEX idx_action_executions_issue ON action_executions (tenant_id, issue_id);
CREATE INDEX idx_action_executions_status ON action_executions (tenant_id, status, next_attempt_at)
  WHERE status IN ('PENDING','FAILED_RETRIABLE');

-- ─── Outbox Messages ──────────────────────────────────────────────────────────

CREATE TABLE outbox_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  action_execution_id   UUID REFERENCES action_executions(id),
  target_system         TEXT NOT NULL CHECK (target_system IN ('zendesk','stripe','shopify')),
  payload               JSONB NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENT','FAILED_RETRIABLE','FAILED_TERMINAL')),
  attempt_count         INT NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  -- effects: persisted local effects ledger (spec Finding 2, spec §4.2.2)
  -- JSONB array of EffectEntry objects. Append-only; prior attempts never deleted.
  effects               JSONB NOT NULL DEFAULT '[]'::jsonb,
  correlation_id        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox_messages (tenant_id, status, next_attempt_at)
  WHERE status IN ('PENDING','FAILED_RETRIABLE');
CREATE INDEX idx_outbox_by_execution ON outbox_messages (action_execution_id);

-- ─── Risk Signals ─────────────────────────────────────────────────────────────

CREATE TABLE risk_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  issue_id            UUID NOT NULL REFERENCES issues(id),
  signal_type         TEXT NOT NULL,
  signal_data         JSONB NOT NULL DEFAULT '{}',
  abuse_signal_level  TEXT NOT NULL DEFAULT 'NONE'
    CHECK (abuse_signal_level IN ('NONE','LOW','MEDIUM','HIGH')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  -- INSERT-ONLY: no UPDATE or DELETE permitted
);

CREATE INDEX idx_risk_signals_issue ON risk_signals (tenant_id, issue_id, created_at DESC);

-- ─── State Transitions ────────────────────────────────────────────────────────
-- INSERT-ONLY. Records APPLIED canonical state changes.
-- Written AFTER execution confirms — NEVER on intent. (spec §4.2 step 5, Finding 3)
-- On FAILED_TERMINAL: no row is written. issues.state is unchanged.

CREATE TABLE state_transitions (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL REFERENCES tenants(id),
  issue_id                        UUID NOT NULL REFERENCES issues(id),
  from_state                      TEXT NOT NULL,
  to_state                        TEXT NOT NULL,
  triggered_by_action_execution_id UUID REFERENCES action_executions(id),
  triggered_by_audit_event_id     UUID,
  note                            TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- INSERT-ONLY enforced by trigger (see trigger below)
);

CREATE INDEX idx_state_transitions_issue ON state_transitions (tenant_id, issue_id, created_at);

-- Trigger: prevent UPDATE or DELETE on state_transitions
CREATE OR REPLACE FUNCTION prevent_state_transition_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'state_transitions is INSERT-ONLY. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_state_transitions_immutability
  BEFORE UPDATE OR DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_state_transition_mutation();

-- ─── Audit Log ────────────────────────────────────────────────────────────────
-- IMMUTABLE. No UPDATE or DELETE ever permitted.

CREATE TABLE audit_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  issue_id                 UUID REFERENCES issues(id),
  event_type               TEXT NOT NULL,
  actor_type               TEXT CHECK (actor_type IN ('agent','system','webhook','operator')),
  actor_id                 TEXT,
  payload                  JSONB,
  policy_rule_id           TEXT,
  policy_version           TEXT,
  normalizer_version       TEXT,
  match_algorithm_version  TEXT,
  -- correlation_id: links inbound event → action → outbox → audit entries
  correlation_id           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger: prevent UPDATE or DELETE on audit_log
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is IMMUTABLE. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_audit_log_immutability
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE INDEX idx_audit_log_issue ON audit_log (tenant_id, issue_id, created_at DESC);
CREATE INDEX idx_audit_log_correlation ON audit_log (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_log_event_type ON audit_log (tenant_id, event_type, created_at DESC);

-- ─── Schema Verification Assertions ──────────────────────────────────────────
-- These DO statements will fail at migration time if schema is wrong.
-- Catching spec/schema drift early.

DO $$
BEGIN
  -- Verify approval_request_id exists on action_executions (spec Finding 1)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_executions'
    AND column_name = 'approval_request_id'
  ), 'SCHEMA INVARIANT VIOLATED: action_executions.approval_request_id missing';

  -- Verify effects column exists on outbox_messages (spec Finding 2)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'outbox_messages'
    AND column_name = 'effects'
  ), 'SCHEMA INVARIANT VIOLATED: outbox_messages.effects missing';

  -- Verify source_event_at exists on inbound_events (spec Finding 10)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inbound_events'
    AND column_name = 'source_event_at'
  ), 'SCHEMA INVARIANT VIOLATED: inbound_events.source_event_at missing';

  -- Verify is_deleted exists on issue_tickets (spec Finding 12)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'issue_tickets'
    AND column_name = 'is_deleted'
  ), 'SCHEMA INVARIANT VIOLATED: issue_tickets.is_deleted missing';

  -- Verify is_source_unavailable (not is_stale) on evidence_normalized (spec Finding 5)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence_normalized'
    AND column_name = 'is_source_unavailable'
  ), 'SCHEMA INVARIANT VIOLATED: evidence_normalized.is_source_unavailable missing (was is_stale)';

  RAISE NOTICE 'Schema invariant assertions passed.';
END;
$$;
