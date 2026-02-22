-- IISL Phase 1 — Migration 004
-- Action execution pipeline: inbound events, approvals, executions, outbox
-- VALIDATION: [COMPILE-PENDING]
-- Spec reference: Section 2.10, Section 1.3, Section 4.2

-- ─── Inbound Events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inbound_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  source_system       TEXT NOT NULL CHECK (source_system IN ('stripe', 'zendesk', 'shopify')),
  external_event_id   TEXT NOT NULL,
  -- source_event_at: authoritative timestamp from the source system (spec Finding 10)
  -- Nullable: not all providers include event timestamp in payload.
  -- Out-of-order processing uses source_event_at when present; received_at as fallback.
  source_event_at     TIMESTAMPTZ,
  source_event_type   TEXT,
  -- payload nullable: nulled after 90-day retention window (spec Finding 4)
  payload                   JSONB,
  payload_redacted_at       TIMESTAMPTZ,
  payload_redaction_reason  TEXT,             -- 'retention_90d' | 'gdpr_erasure'
  payload_hash              TEXT,             -- SHA-256 of original, preserved post-redaction
  signature_valid           BOOLEAN NOT NULL,
  received_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at              TIMESTAMPTZ,
  status                    TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DUPLICATE')),
  error                     TEXT,
  UNIQUE (tenant_id, source_system, external_event_id)
);

CREATE INDEX idx_inbound_events_status ON inbound_events (tenant_id, status, received_at);

-- ─── Approval Requests ────────────────────────────────────────────────────────

-- Approvals authorize execution. They are not execution.
-- No action_executions row exists while approval is PENDING.
-- When approvals_enabled = false, this table is never written to.

CREATE TABLE IF NOT EXISTS approval_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID NOT NULL REFERENCES issues(id),
  requested_by_agent_id     TEXT NOT NULL,
  action_type               TEXT NOT NULL,
  action_payload            JSONB NOT NULL,
  required_role             TEXT NOT NULL DEFAULT 'manager',
  approval_policy_code      TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED')),
  assigned_queue            TEXT,
  assigned_manager_id       TEXT,
  reason                    TEXT,
  -- linked_action_execution_id set atomically when approval is APPROVED
  linked_action_execution_id UUID,           -- FK added below after action_executions
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ,
  approved_at               TIMESTAMPTZ,
  denied_at                 TIMESTAMPTZ,
  resolved_by_agent_id      TEXT
);

CREATE INDEX idx_approval_requests_issue ON approval_requests (tenant_id, issue_id, status);
CREATE INDEX idx_approval_requests_pending ON approval_requests (tenant_id, status, expires_at)
  WHERE status = 'PENDING';

-- ─── Action Executions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS action_executions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  issue_id              UUID NOT NULL REFERENCES issues(id),
  action_type           TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  -- planned_state: intended issues.state after this action.
  -- NOT written to state_transitions until execution completes successfully.
  -- On FAILED_TERMINAL, planned_state remains unwritten to state_transitions.
  planned_state         TEXT,
  status                TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING', 'IN_PROGRESS', 'COMPLETED',
      'FAILED_RETRIABLE', 'FAILED_TERMINAL'
    )),
  result_payload        JSONB,
  error                 TEXT,
  attempt_count         INT NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ,
  policy_rule_id        TEXT,
  policy_version        TEXT,
  -- Approval linkage (spec Finding 1)
  -- When not null: this execution was created via approval path.
  approval_request_id   UUID REFERENCES approval_requests(id),
  -- Reconciliation metadata (spec Finding 7)
  -- Status stays FAILED_TERMINAL; reconciliation is stored as metadata.
  reconciled_at         TIMESTAMPTZ,
  reconciled_by         TEXT,
  reconciliation_outcome TEXT, -- 'CONFIRMED_OCCURRED' | 'CONFIRMED_NOT_OCCURRED' | 'UNKNOWN'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ
);

-- Idempotency guard: at most one action_executions row per approval_request_id
-- (spec Section 1.3.4, Finding 1)
CREATE UNIQUE INDEX uix_action_executions_approval
  ON action_executions (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

CREATE INDEX idx_action_executions_status ON action_executions (tenant_id, status, next_attempt_at);
CREATE INDEX idx_action_executions_issue ON action_executions (tenant_id, issue_id);

-- Add FK from approval_requests to action_executions now that the table exists
ALTER TABLE approval_requests
  ADD CONSTRAINT fk_approval_linked_execution
  FOREIGN KEY (linked_action_execution_id)
  REFERENCES action_executions(id);

-- Add FK from state_transitions to action_executions
ALTER TABLE state_transitions
  ADD CONSTRAINT fk_state_transition_execution
  FOREIGN KEY (action_execution_id)
  REFERENCES action_executions(id);

-- ─── Outbox Messages ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbox_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  action_execution_id   UUID REFERENCES action_executions(id),
  target_system         TEXT NOT NULL CHECK (target_system IN ('zendesk', 'stripe', 'shopify')),
  payload               JSONB NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENT', 'FAILED_RETRIABLE', 'FAILED_TERMINAL')),
  attempt_count         INT NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  -- Effects ledger: JSONB array of EffectLedgerEntry records (spec Section 4.2.2)
  -- Append-only. Prior attempt entries are never deleted.
  -- Each element follows the canonical EffectLedgerEntry schema in @iisl/shared.
  effects               JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox_messages (tenant_id, status, next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED_RETRIABLE');
