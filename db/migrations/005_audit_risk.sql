-- IISL Phase 1 — Migration 005
-- Risk signals (append-only events), audit log (immutable), commitments
-- VALIDATION: [COMPILE-PENDING]
-- Spec reference: Section 2.6, 2.11, 2.9

-- ─── Risk Signals (append-only event-level records) ──────────────────────────

CREATE TABLE IF NOT EXISTS risk_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  issue_id        UUID NOT NULL REFERENCES issues(id),
  signal_type     TEXT NOT NULL,   -- e.g. 'reopen', 'amount_dispute', 'rapid_close'
  severity        TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Windowed aggregate queries always include tenant_id + issue_id + time window
CREATE INDEX idx_risk_signals_issue ON risk_signals (tenant_id, issue_id, created_at);

-- ─── Audit Log (Immutable — INSERT ONLY) ─────────────────────────────────────

-- This table must be INSERT-only at the application role level.
-- A trigger enforces this: UPDATE and DELETE raise exceptions.
-- See trigger below.

CREATE TABLE IF NOT EXISTS audit_log (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID REFERENCES issues(id),
  event_type                TEXT NOT NULL,
  actor_type                TEXT CHECK (actor_type IN ('agent', 'system', 'webhook', 'operator')),
  actor_id                  TEXT,
  payload                   JSONB,
  policy_rule_id            TEXT,
  policy_version            TEXT,
  normalizer_version        TEXT,
  match_algorithm_version   TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_issue ON audit_log (tenant_id, issue_id, created_at);
CREATE INDEX idx_audit_log_event ON audit_log (tenant_id, event_type, created_at);

-- Immutability enforcement trigger
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable. UPDATE and DELETE are not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- state_transitions immutability enforcement
CREATE OR REPLACE FUNCTION state_transitions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'state_transitions is append-only. UPDATE and DELETE are not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER state_transitions_no_update
  BEFORE UPDATE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION state_transitions_append_only();

CREATE TRIGGER state_transitions_no_delete
  BEFORE DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION state_transitions_append_only();

-- ─── Commitments ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commitments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  issue_id        UUID NOT NULL REFERENCES issues(id),
  commitment_type TEXT NOT NULL,       -- e.g. 'follow_up_check', 'refund_deadline'
  due_date        DATE NOT NULL,       -- evaluated as due_date < CURRENT_DATE in tenant tz
  status          TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'MET', 'BREACHED', 'CANCELLED')),
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_commitments_due ON commitments (tenant_id, status, due_date)
  WHERE status = 'PENDING';
