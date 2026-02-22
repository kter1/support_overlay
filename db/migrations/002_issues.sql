-- IISL Phase 1 — Migration 002
-- Issues, tickets, state transitions (applied-only, append-only)
-- VALIDATION: [COMPILE-PENDING]
-- Spec reference: Section 2, Section 3 (state machine), Section 4.2

-- ─── Issues ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  -- customer fields nullable: nulled on GDPR/CCPA erasure request (spec Finding 4)
  customer_id     TEXT,
  customer_email  TEXT,
  -- Four canonical states. No REOPENED state. Reopen is an event (reopen_events).
  state           TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN', 'AWAITING_FULFILLMENT', 'BLOCKED', 'RESOLVED')),
  -- Optimistic concurrency control: every state mutation must supply expected lock_version
  lock_version    INT NOT NULL DEFAULT 0,
  playbook_id     TEXT NOT NULL DEFAULT 'refund_v1',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_issues_tenant_state ON issues (tenant_id, state);

-- ─── Issue Tickets (Zendesk linkage) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issue_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  issue_id          UUID NOT NULL REFERENCES issues(id),
  zendesk_ticket_id TEXT NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  -- is_deleted: set true when Zendesk ticket is deleted or hard-removed (spec Finding 12)
  -- Metadata row is preserved; Issue and evidence are NEVER deleted.
  is_deleted        BOOLEAN NOT NULL DEFAULT false,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, zendesk_ticket_id)
);

-- Efficient filtering of active (non-deleted) tickets
CREATE INDEX idx_issue_tickets_active
  ON issue_tickets (tenant_id, issue_id)
  WHERE is_deleted = false;

-- ─── State Transitions (applied canonical changes only, append-only) ──────────

-- CRITICAL: state_transitions records ONLY applied canonical state changes.
-- An entry is written ONLY after external execution confirms (step 5 of action lifecycle).
-- Intended/planned transitions live in action_executions.planned_state.
-- If an action reaches FAILED_TERMINAL, NO row is written here.
-- This table is the canonical source for state replay.

CREATE TABLE IF NOT EXISTS state_transitions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  issue_id              UUID NOT NULL REFERENCES issues(id),
  from_state            TEXT NOT NULL,
  to_state              TEXT NOT NULL,
  action_execution_id   UUID,               -- FK added after action_executions created
  trigger_event         TEXT NOT NULL,       -- e.g. 'close_confirmed', 'evidence_refresh', 'operator_repair'
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('agent', 'system', 'webhook', 'operator')),
  actor_id              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INSERT-ONLY enforced by application role privilege and trigger
CREATE INDEX idx_state_transitions_issue ON state_transitions (tenant_id, issue_id, created_at);

-- ─── Reopen Events (events, not states) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS reopen_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  issue_id              UUID NOT NULL REFERENCES issues(id),
  reopened_by_agent_id  TEXT NOT NULL,
  reason                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reopen_events_issue ON reopen_events (tenant_id, issue_id);
