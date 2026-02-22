/**
 * @iisl/api — Audit Log Service
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * All writes to audit_log go through this service.
 * The table is INSERT-only (trigger prevents UPDATE/DELETE at DB level).
 * Every event must include event_type and actor_type.
 * policy_rule_id must be included for all policy evaluation events.
 *
 * Spec reference: Section 2.11, Section 1.1
 */
import { PoolClient } from "pg";
import { query } from "../db/pool";
import { ActorType } from "@iisl/shared";

export interface AuditEvent {
  tenantId: string;
  issueId?: string;
  eventType: string;
  actorType: ActorType;
  actorId?: string;
  payload?: Record<string, unknown>;
  policyRuleId?: string;
  policyVersion?: string;
  normalizerVersion?: string;
  matchAlgorithmVersion?: string;
}

/**
 * Write an audit event. Uses pool (no transaction needed for audit log writes
 * that are outside a transaction context).
 */
export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  await query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, actor_id, payload,
        policy_rule_id, policy_version, normalizer_version, match_algorithm_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.tenantId,
      event.issueId ?? null,
      event.eventType,
      event.actorType,
      event.actorId ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.policyRuleId ?? null,
      event.policyVersion ?? null,
      event.normalizerVersion ?? null,
      event.matchAlgorithmVersion ?? null,
    ]
  );
}

/**
 * Write an audit event within an existing transaction.
 * Use this when the audit write must be atomic with other operations.
 */
export async function writeAuditEventTx(
  client: PoolClient,
  event: AuditEvent
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, actor_id, payload,
        policy_rule_id, policy_version, normalizer_version, match_algorithm_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.tenantId,
      event.issueId ?? null,
      event.eventType,
      event.actorType,
      event.actorId ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.policyRuleId ?? null,
      event.policyVersion ?? null,
      event.normalizerVersion ?? null,
      event.matchAlgorithmVersion ?? null,
    ]
  );
}

// ─── Standard Event Type Constants ───────────────────────────────────────────
// Use these to avoid typos in event_type values across the codebase.

export const AuditEventType = {
  // Policy events
  POLICY_DECISION: "policy_decision",

  // Card events (bypass detection proxy signal)
  CARD_LOADED: "card_loaded",
  CARD_CTA_CLICKED: "card_cta_clicked",

  // Approval lifecycle
  ACTION_REQUIRES_APPROVAL: "action_requires_approval",
  APPROVAL_GRANTED: "approval_granted",
  APPROVAL_DENIED: "approval_denied",
  APPROVAL_EXPIRED: "approval_expired",
  APPROVAL_CANCELLED: "approval_cancelled",

  // Action execution lifecycle
  ACTION_EXECUTION_CREATED: "action_execution_created",
  ACTION_EXECUTION_COMPLETED: "action_execution_completed",
  ACTION_EXECUTION_RETRY: "action_execution_retry",
  ACTION_EXECUTION_FAILED_TERMINAL: "action_execution_failed_terminal",
  ACTION_EXECUTION_RECONCILED: "action_execution_reconciled",

  // Evidence events
  EVIDENCE_FETCHED: "evidence_fetched",
  EVIDENCE_FETCH_FAILED: "evidence_fetch_failed",
  EVIDENCE_OUTDATED: "evidence_outdated",

  // Tombstone / source events
  TICKET_MERGED: "ticket_merged",
  TICKET_SOURCE_DELETED: "ticket_source_deleted",
  SOURCE_UNAVAILABLE: "source_unavailable",
  ORDER_ARCHIVED: "order_archived",

  // Card state events
  CARD_STATE_REBUILT: "card_state_rebuilt",

  // Operator repair events
  OPERATOR_REBUILD_CARD_STATE: "operator_rebuild_card_state",
  OPERATOR_REPLAY_EVENT: "operator_replay_event",
  OPERATOR_RECONCILE_EXECUTION: "operator_reconcile_execution",
  OPERATOR_FORCE_SYNC_ZENDESK: "operator_force_sync_zendesk",

  // Inbound events
  INBOUND_EVENT_RECEIVED: "inbound_event_received",
  INBOUND_EVENT_PROCESSED: "inbound_event_processed",
  INBOUND_EVENT_FAILED: "inbound_event_failed",
  INBOUND_EVENT_REPLAYED: "inbound_event_replayed",
} as const;
