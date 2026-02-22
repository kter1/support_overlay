/**
 * @file packages/shared/src/enums.ts
 * @description Canonical vocabulary for the IISL system.
 *
 * This file is the single source of truth for all status enums, outcome types,
 * and vocabulary constants used across the API, worker, policy engine, sidebar,
 * and connectors. No enum value may be defined elsewhere and imported here.
 *
 * Validation level: [Syntax-checked]
 *
 * CRITICAL NAMING NOTE (spec v1.1.3 §1.5):
 *   FAILED_RETRIABLE — canonical spelling used for BOTH:
 *     - action_executions.status enum
 *     - outbox_messages.status enum
 *     - effects ledger outcome_status vocabulary
 *   A prior version used FAILED_RETRYABLE in some effects-ledger contexts.
 *   That has been normalized. One spelling, all domains.
 *
 * STALENESS NOTE (spec v1.1.3 §4.4):
 *   Two distinct concepts — do not conflate:
 *   - Time-based freshness: computed at card read time from timestamps. NOT stored.
 *   - Source unavailability: persisted boolean flag (is_source_unavailable) set by
 *     tombstone logic or operator. Distinct from time-based staleness.
 */

// ─── Policy Outcomes ───────────────────────────────────────────────────────
// Returned by the policy engine preflight evaluation.
// These are PREFLIGHT outcomes only — not execution outcomes.
// FAILED_TERMINAL is NOT a policy outcome. See spec §1.6, §4.2.1.

export const PolicyOutcome = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  REQUIRES_APPROVAL: "REQUIRES_APPROVAL",
} as const;
export type PolicyOutcome = (typeof PolicyOutcome)[keyof typeof PolicyOutcome];

// ─── Approval Request Statuses ─────────────────────────────────────────────

export const ApprovalStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

// ─── Action Execution Statuses ─────────────────────────────────────────────
// Tracks the lifecycle of an outbound action.
// FAILED_RETRIABLE = retriable execution failure
// FAILED_TERMINAL  = terminal execution failure (operator repair required)
// Neither is a policy outcome. Policy denial produces NO action_executions row.

export const ExecutionStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED_RETRIABLE: "FAILED_RETRIABLE",
  FAILED_TERMINAL: "FAILED_TERMINAL",
} as const;
export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

// ─── Outbox Message Statuses ───────────────────────────────────────────────

export const OutboxStatus = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED_RETRIABLE: "FAILED_RETRIABLE",
  FAILED_TERMINAL: "FAILED_TERMINAL",
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

// ─── Effects Ledger — outcome_status Vocabulary ────────────────────────────
// Per outbox_messages.effects JSONB array entries.
// Canonical spelling: FAILED_RETRIABLE (matches execution and outbox enums).

export const EffectOutcomeStatus = {
  INTENDED: "INTENDED",         // Recorded before send. Network call not yet made.
  SENT_ACKED: "SENT_ACKED",     // Provider returned explicit success.
  SENT_UNCERTAIN: "SENT_UNCERTAIN", // Request dispatched; response timed out. Unknown outcome.
  CONFIRMED: "CONFIRMED",       // Effect verified via provider read or acked response.
  FAILED_RETRIABLE: "FAILED_RETRIABLE", // Provider returned retriable error. Add new attempt.
  FAILED_TERMINAL: "FAILED_TERMINAL",   // Permanent error or retry budget exhausted.
} as const;
export type EffectOutcomeStatus = (typeof EffectOutcomeStatus)[keyof typeof EffectOutcomeStatus];

// ─── Retry Classification ──────────────────────────────────────────────────
// Per action type (spec §4.2.3)

export const RetryClass = {
  SAFE_AUTO_RETRY: "SAFE_AUTO_RETRY",               // Idempotent; retry freely
  AUTO_RETRY_WITH_DEDUPE: "AUTO_RETRY_WITH_DEDUPE", // Retry after effects-ledger dedupe check
  OPERATOR_RETRY_ONLY: "OPERATOR_RETRY_ONLY",       // No auto-retry; operator must reconcile
  NEVER_AUTO_RETRY: "NEVER_AUTO_RETRY",             // Not retriable by design
} as const;
export type RetryClass = (typeof RetryClass)[keyof typeof RetryClass];

// ─── Action Types ──────────────────────────────────────────────────────────

export const ActionType = {
  CLOSE_CONFIRMED: "close_confirmed",
  ESCALATE_MISSING: "escalate_missing",
  UPDATE_PENDING: "update_pending",
  REOPEN_ISSUE: "reopen_issue",
  REFRESH_EVIDENCE: "refresh_evidence",
  POST_COMMENT: "post_comment",
  SET_ZENDESK_STATUS: "set_zendesk_status",
  INITIATE_STRIPE_REFUND: "initiate_stripe_refund",
  SEND_APPROVAL_NOTIFICATION: "send_approval_notification",
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

// ─── Issue State ───────────────────────────────────────────────────────────
// Canonical issue lifecycle states. REOPENED is NOT a state — it is an event.
// A reopened issue returns to OPEN.

export const IssueState = {
  OPEN: "OPEN",
  PENDING_EVIDENCE: "PENDING_EVIDENCE",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  ACTION_IN_PROGRESS: "ACTION_IN_PROGRESS",
  RESOLVED: "RESOLVED",
  ESCALATED: "ESCALATED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;
export type IssueState = (typeof IssueState)[keyof typeof IssueState];

// ─── Inbound Event Statuses ────────────────────────────────────────────────

export const InboundEventStatus = {
  RECEIVED: "RECEIVED",
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
  DUPLICATE: "DUPLICATE",
} as const;
export type InboundEventStatus = (typeof InboundEventStatus)[keyof typeof InboundEventStatus];

// ─── Source Systems ────────────────────────────────────────────────────────

export const SourceSystem = {
  ZENDESK: "zendesk",
  STRIPE: "stripe",
  SHOPIFY: "shopify",
} as const;
export type SourceSystem = (typeof SourceSystem)[keyof typeof SourceSystem];

// ─── Evidence Freshness (computed, never stored as a flag) ─────────────────
// These labels are computed at read time from timestamps vs freshness window.
// is_source_unavailable is a separate persisted field for tombstone state.

export const FreshnessStatus = {
  FRESH: "FRESH",
  STALE: "STALE",
  MISSING: "MISSING",
} as const;
export type FreshnessStatus = (typeof FreshnessStatus)[keyof typeof FreshnessStatus];

// ─── Match Band ────────────────────────────────────────────────────────────
// Evidence match confidence for the refund playbook.

export const MatchBand = {
  HIGH: "HIGH",     // Strong evidence match; policy likely ALLOW
  MEDIUM: "MEDIUM", // Partial match; may require approval
  LOW: "LOW",       // Weak match; likely escalation or denial
  NONE: "NONE",     // No evidence match
} as const;
export type MatchBand = (typeof MatchBand)[keyof typeof MatchBand];

// ─── Risk Tier ─────────────────────────────────────────────────────────────

export const RiskTier = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;
export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

// ─── Abuse Signal Level ────────────────────────────────────────────────────

export const AbuseSignalLevel = {
  NONE: "NONE",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;
export type AbuseSignalLevel = (typeof AbuseSignalLevel)[keyof typeof AbuseSignalLevel];

// ─── Audit Event Types ─────────────────────────────────────────────────────

export const AuditEventType = {
  // Policy
  POLICY_DECISION: "policy_decision",
  // Approval
  ACTION_REQUIRES_APPROVAL: "action_requires_approval",
  APPROVAL_GRANTED: "approval_granted",
  APPROVAL_DENIED: "approval_denied",
  APPROVAL_EXPIRED: "approval_expired",
  // Execution
  ACTION_EXECUTION_CREATED: "action_execution_created",
  ACTION_EXECUTION_COMPLETED: "action_execution_completed",
  ACTION_EXECUTION_RETRY: "action_execution_retry",
  ACTION_EXECUTION_FAILED_TERMINAL: "action_execution_failed_terminal",
  ACTION_EXECUTION_RECONCILED: "action_execution_reconciled",
  // Evidence
  EVIDENCE_FETCHED: "evidence_fetched",
  EVIDENCE_NORMALIZED: "evidence_normalized",
  EVIDENCE_MATCH_COMPUTED: "evidence_match_computed",
  // Tombstone / merge
  TICKET_SOURCE_DELETED: "ticket_source_deleted",
  TICKET_MERGED: "ticket_merged",
  ORDER_ARCHIVED: "order_archived",
  SOURCE_UNAVAILABLE: "source_unavailable",
  // Operator repair
  CARD_STATE_REBUILT: "card_state_rebuilt",
  INBOUND_EVENT_REPLAYED: "inbound_event_replayed",
  OPERATOR_FORCE_SYNC: "operator_force_sync",
  // State transitions
  ISSUE_STATE_CHANGED: "issue_state_changed",
  // Retention / erasure
  PAYLOAD_REDACTED: "payload_redacted",
} as const;
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

// ─── Actor Types (for audit log) ───────────────────────────────────────────

export const ActorType = {
  AGENT: "agent",
  SYSTEM: "system",
  WEBHOOK: "webhook",
  OPERATOR: "operator",
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

// ─── UI Card State Labels ──────────────────────────────────────────────────
// Used in Resolution Card rendering. No accusation language.

export const UIStateLabel = {
  ACTION_QUEUED: "Action queued",
  BLOCKED_BY_POLICY: "Blocked — additional review required",
  AWAITING_APPROVAL: "Awaiting manager approval",
  REQUEST_DENIED: "Request requires escalation",
  APPROVAL_EXPIRED: "Approval expired — re-request to continue",
  ACTION_COMPLETE: "Action complete",
  ACTION_RETRYING: "Action in progress — check back shortly",
  ACTION_FAILED: "Action requires support review",
  SOURCE_UNAVAILABLE: "Source record no longer available — case record preserved",
} as const;
export type UIStateLabel = (typeof UIStateLabel)[keyof typeof UIStateLabel];

// ─── Redaction Reasons ─────────────────────────────────────────────────────

export const RedactionReason = {
  RETENTION_90D: "retention_90d",
  GDPR_ERASURE: "gdpr_erasure",
  CCPA_ERASURE: "ccpa_erasure",
} as const;
export type RedactionReason = (typeof RedactionReason)[keyof typeof RedactionReason];

// ─── Reconciliation Outcomes ───────────────────────────────────────────────
// Used in action_executions.reconciliation_outcome (not a status, not an enum expansion)

export const ReconciliationOutcome = {
  CONFIRMED_OCCURRED: "CONFIRMED_OCCURRED",
  CONFIRMED_NOT_OCCURRED: "CONFIRMED_NOT_OCCURRED",
  UNKNOWN: "UNKNOWN",
} as const;
export type ReconciliationOutcome = (typeof ReconciliationOutcome)[keyof typeof ReconciliationOutcome];
