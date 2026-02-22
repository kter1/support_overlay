/**
 * @file packages/shared/src/types.ts
 * @description Domain model types for IISL.
 *
 * These types mirror the database schema exactly. Any schema change must be
 * reflected here and vice versa. See spec §2 for DDL reference.
 *
 * Validation level: [Compile: pending npm install]
 */

import type {
  PolicyOutcome,
  ApprovalStatus,
  ExecutionStatus,
  OutboxStatus,
  EffectOutcomeStatus,
  ActionType,
  IssueState,
  InboundEventStatus,
  SourceSystem,
  MatchBand,
  RiskTier,
  AbuseSignalLevel,
  AuditEventType,
  ActorType,
  ReconciliationOutcome,
} from "./enums";

// ─── Core Domain ───────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  createdAt: Date;
}

export interface TenantConfig {
  id: string;
  tenantId: string;
  // Approval toggle — OFF by default for all pilot tenants (spec §build req)
  approvalsEnabled: boolean;
  // Evidence freshness window in seconds
  evidenceFreshnessSeconds: number;
  // Amount tolerance for refund matching (e.g. 0.05 = 5% tolerance)
  refundAmountTolerancePct: number;
  // Manager approval group ID (normalized from manager_approval_group_id)
  managerApprovalGroupId: string | null;
  // Zendesk-specific
  zendeskSubdomain: string | null;
  zendeskAgentGroupId: string | null;
  updatedAt: Date;
}

export interface Issue {
  id: string;
  tenantId: string;
  // customer_id and customer_email are nullable — nulled on GDPR/CCPA erasure
  customerId: string | null;
  customerEmail: string | null;
  state: IssueState;
  lockVersion: number; // Optimistic lock for concurrent state writes
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueTicket {
  id: string;
  tenantId: string;
  issueId: string;
  zendeskTicketId: string;
  isPrimary: boolean;
  // Tombstone fields — set when Zendesk ticket is deleted (not destructive)
  isDeleted: boolean;
  deletedAt: Date | null;
  createdAt: Date;
}

// ─── Evidence ──────────────────────────────────────────────────────────────

export interface EvidenceRawSnapshot {
  id: string;
  tenantId: string;
  issueId: string;
  sourceSystem: SourceSystem;
  sourceRecordId: string;
  normalizerVersion: string;
  // raw_data is nullable: nulled after 90-day retention or GDPR erasure
  rawData: Record<string, unknown> | null;
  rawDataRedactedAt: Date | null;
  rawDataRedactionReason: string | null;
  rawDataHash: string | null; // SHA-256 of original, preserved post-redaction
  createdAt: Date;
}

export interface EvidenceNormalized {
  id: string;
  tenantId: string;
  issueId: string;
  sourceSystem: SourceSystem;
  sourceRecordId: string;
  rawSnapshotId: string;
  normalizerVersion: string;
  // Key extracted fields (varies by source)
  normalizedData: NormalizedEvidence;
  fetchedAt: Date;
  // is_source_unavailable: persisted flag for tombstone/archival/deleted state.
  // NOT time-based freshness. Time-based freshness is computed at read time
  // from fetchedAt vs evidenceFreshnessSeconds. (spec §4.4, §1.1.3 Finding 5)
  isSourceUnavailable: boolean;
  sourceUnavailableReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedEvidence {
  // Stripe
  stripeChargeId?: string;
  stripeRefundId?: string;
  stripeRefundStatus?: string;
  stripeChargeAmount?: number;
  stripeCurrency?: string;
  stripeChargeCreatedAt?: string;
  stripeCustomerId?: string;
  // Shopify
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  shopifyFinancialStatus?: string;
  shopifyFulfillmentStatus?: string;
  shopifyOrderTotal?: number;
  shopifyOrderCurrency?: string;
  shopifyOrderCreatedAt?: string;
  // Zendesk (from ticket)
  zendeskTicketId?: string;
  zendeskStatus?: string;
  zendeskSubject?: string;
  zendeskTags?: string[];
  // Common
  refundAmount?: number;
  refundCurrency?: string;
}

export interface EvidenceMatchResult {
  id: string;
  tenantId: string;
  issueId: string;
  matchAlgorithmVersion: string;
  matchBand: MatchBand;
  confidenceScore: number; // 0.0–1.0
  matchedFields: string[]; // Which fields contributed to match
  matchNotes: string | null; // Non-accusatory explanation
  computedAt: Date;
}

// ─── Issue Card State (denormalized read model) ────────────────────────────

export interface IssueCardState {
  id: string;
  tenantId: string;
  issueId: string;
  zendeskTicketId: string;
  // Current issue state
  issueState: IssueState;
  // Evidence summary
  matchBand: MatchBand | null;
  confidenceScore: number | null;
  // Freshness — computed from fetchedAt at read time (not stored as flag)
  evidenceFetchedAt: Date | null;
  isSourceUnavailable: boolean;
  // Current action status
  pendingActionExecutionId: string | null;
  lastActionType: ActionType | null;
  lastActionCompletedAt: Date | null;
  // Approval state
  pendingApprovalRequestId: string | null;
  // Denormalized evidence summary for fast card render
  evidenceSummary: EvidenceSummary | null;
  // Read model metadata
  lastRebuiltAt: Date;
  rebuiltFromActionExecutionId: string | null;
}

export interface EvidenceSummary {
  stripeRefundStatus?: string;
  stripeChargeAmount?: number;
  shopifyOrderName?: string;
  shopifyFinancialStatus?: string;
  refundAmount?: number;
  currency?: string;
  sourceUnavailable?: boolean;
  sourceUnavailableReason?: string;
}

// ─── Inbound Events ────────────────────────────────────────────────────────

export interface InboundEvent {
  id: string;
  tenantId: string;
  sourceSystem: SourceSystem;
  externalEventId: string;
  // source_event_at: authoritative timestamp from source system (spec Finding 10)
  // May be null if provider does not include event timestamp
  sourceEventAt: Date | null;
  sourceEventType: string | null;
  // payload is nullable: nulled after 90-day retention window
  payload: Record<string, unknown> | null;
  payloadRedactedAt: Date | null;
  payloadRedactionReason: string | null;
  payloadHash: string | null;
  signatureValid: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  status: InboundEventStatus;
  error: string | null;
}

// ─── Approvals ─────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  issueId: string;
  actionType: ActionType;
  requestedByAgentId: string;
  actionPayload: Record<string, unknown>; // What will execute on approval
  status: ApprovalStatus;
  policyRuleId: string;
  policyVersion: string;
  reviewedByManagerId: string | null;
  reviewNotes: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Action Executions ─────────────────────────────────────────────────────

export interface ActionExecution {
  id: string;
  tenantId: string;
  issueId: string;
  actionType: ActionType;
  requestedByAgentId: string;
  idempotencyKey: string;
  // planned_state: intended issues.state after this action completes.
  // NOT written to state_transitions until execution confirms. (spec §4.2 step 2)
  plannedState: IssueState | null;
  status: ExecutionStatus;
  resultPayload: Record<string, unknown> | null;
  error: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  policyRuleId: string | null;
  policyVersion: string | null;
  // Approval linkage — partial unique index enforces approval→execution 1:1 (spec Finding 1)
  approvalRequestId: string | null;
  // Reconciliation metadata — status stays FAILED_TERMINAL; these fields track manual resolution
  reconciledAt: Date | null;
  reconciledBy: string | null;
  reconciliationOutcome: ReconciliationOutcome | null;
  createdAt: Date;
  completedAt: Date | null;
}

// ─── Outbox ────────────────────────────────────────────────────────────────

export interface OutboxMessage {
  id: string;
  tenantId: string;
  actionExecutionId: string | null;
  targetSystem: SourceSystem;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  // effects: persisted local effects ledger — canonical per spec §4.2.2 (spec Finding 2)
  effects: EffectEntry[];
  createdAt: Date;
}

export interface EffectEntry {
  effectType: string;          // e.g. "zendesk_comment_post", "zendesk_status_set"
  targetSystem: SourceSystem;
  targetResourceId: string;    // e.g. "ticket/12345"
  effectKey: string;           // Deterministic dedupe key
  attemptNumber: number;       // 1-based, new entry per retry
  outcomeStatus: EffectOutcomeStatus;
  providerCorrelationId: string | null; // Provider-assigned ID on success
  intendedAt: string;          // ISO timestamp — before network call
  sentAt: string | null;       // ISO timestamp — after dispatch
  confirmedAt: string | null;  // ISO timestamp — after verification
}

// ─── Audit Log ─────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  issueId: string | null;
  eventType: AuditEventType;
  actorType: ActorType;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  policyRuleId: string | null;
  policyVersion: string | null;
  normalizerVersion: string | null;
  matchAlgorithmVersion: string | null;
  correlationId: string | null; // Links inbound event → action → outbox → audit
  createdAt: Date;
}

// ─── State Transitions ─────────────────────────────────────────────────────
// INSERT-ONLY. Records applied canonical state changes.
// Written AFTER execution confirms — not on intent. (spec §4.2 step 5, Finding 3)

export interface StateTransition {
  id: string;
  tenantId: string;
  issueId: string;
  fromState: IssueState;
  toState: IssueState;
  triggeredByActionExecutionId: string | null;
  triggeredByAuditEventId: string | null;
  note: string | null;
  createdAt: Date;
}

// ─── Risk Signals ──────────────────────────────────────────────────────────

export interface RiskSignal {
  id: string;
  tenantId: string;
  issueId: string;
  signalType: string;
  signalData: Record<string, unknown>;
  abuseSignalLevel: AbuseSignalLevel;
  createdAt: Date;
}

// ─── Policy Engine Contracts ───────────────────────────────────────────────

export interface PolicyInput {
  tenantId: string;
  issueId: string;
  actionType: ActionType;
  agentId: string;
  matchBand: MatchBand | null;
  refundAmount: number | null;
  riskTier: RiskTier;
  abuseSignalLevel: AbuseSignalLevel;
  evidenceFreshAt: boolean;   // Computed freshness check result
  isSourceUnavailable: boolean;
  approvalsEnabled: boolean;  // From tenant_config
  correlationId: string;
}

export interface PolicyResult {
  outcome: PolicyOutcome;
  policyRuleId: string;
  policyVersion: string;
  denyReason: string | null;         // Non-accusatory. Shown to agent on DENY.
  requiresApprovalReason: string | null;
  softWarnings: string[];            // Non-blocking informational notes
  auditPayload: Record<string, unknown>;
}

// ─── API Response Types ────────────────────────────────────────────────────

export interface CardReadResponse {
  issueId: string;
  zendeskTicketId: string;
  issueState: IssueState;
  matchBand: MatchBand | null;
  confidenceScore: number | null;
  // Freshness computed at read time — spec §4.4
  freshnessStatus: "FRESH" | "STALE" | "MISSING";
  evidenceFetchedAt: string | null;
  isSourceUnavailable: boolean;
  sourceUnavailableReason: string | null;
  evidenceSummary: EvidenceSummary | null;
  pendingApprovalRequestId: string | null;
  pendingActionExecutionId: string | null;
  lastActionType: ActionType | null;
  lastActionCompletedAt: string | null;
  availableCtas: AvailableCta[];
  softWarnings: string[];
  correlationId: string;
  lastRebuiltAt: string;
}

export interface AvailableCta {
  actionType: ActionType;
  label: string;             // Non-accusatory UI label
  requiresApproval: boolean; // True if approvalsEnabled and policy says REQUIRES_APPROVAL
  disabled: boolean;
  disabledReason: string | null;
}

export interface ActionRequestBody {
  actionType: ActionType;
  idempotencyKey: string;
  agentId: string;
  actionPayload?: Record<string, unknown>;
}

export interface ActionResponse {
  actionExecutionId: string | null;
  approvalRequestId: string | null;
  policyOutcome: PolicyOutcome;
  status: ExecutionStatus | null;
  message: string;
  correlationId: string;
}
