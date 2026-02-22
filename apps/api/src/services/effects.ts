/**
 * @iisl/api — Effects Ledger Builder
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Builds the outbox_messages and initial effects ledger entries for each action.
 * effect_key is deterministic: action_execution_id + effect_type + target_resource_id
 * For comment posting: additionally hash the comment content.
 *
 * Spec reference: Section 4.2.2, Section 4.2.3
 */
import { createHash } from "crypto";
import {
  ActionType,
  SourceSystem,
  EffectOutcomeStatus,
  EffectLedgerEntry,
} from "@iisl/shared";

export interface PlannedEffect {
  targetSystem: SourceSystem;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  initialLedgerEntry: EffectLedgerEntry;
}

/**
 * Build the set of outbox_messages + initial effects ledger entries
 * for a given action type and parameters.
 */
export function buildEffectsForAction(
  actionType: ActionType,
  executionId: string,
  params: Record<string, unknown>
): PlannedEffect[] {
  const now = new Date().toISOString();

  switch (actionType) {
    case ActionType.CLOSE_CONFIRMED:
      return buildCloseConfirmedEffects(executionId, params, now);

    case ActionType.ESCALATE_MISSING:
      return buildEscalateMissingEffects(executionId, params, now);

    case ActionType.UPDATE_PENDING:
      return buildUpdatePendingEffects(executionId, params, now);

    case ActionType.POST_COMMENT:
      return buildPostCommentEffects(executionId, params, now);

    case ActionType.NOTIFY_MANAGER_APPROVAL:
      return buildNotifyApprovalEffects(executionId, params, now);

    case ActionType.REFRESH_EVIDENCE:
      // Evidence refresh has no outbox messages (pull-based, not push)
      return [];

    case ActionType.REOPEN_ISSUE:
      // Local DB operation only — no outbox messages
      return [];

    default:
      return [];
  }
}

// ─── Action-specific effect builders ─────────────────────────────────────────

function buildCloseConfirmedEffects(
  executionId: string,
  params: Record<string, unknown>,
  now: string
): PlannedEffect[] {
  const ticketId = params.zendesk_ticket_id as string;
  const commentBody = params.resolution_comment as string | undefined;
  const effects: PlannedEffect[] = [];

  // Effect 1: Set Zendesk ticket status to "solved"
  // Retry class: RECONCILIATION_FIRST
  const statusEffectKey = buildEffectKey(
    executionId,
    "zendesk_status_set",
    `ticket/${ticketId}`
  );

  effects.push({
    targetSystem: SourceSystem.ZENDESK,
    payload: {
      operation: "update_ticket_status",
      zendesk_ticket_id: ticketId,
      target_status: "solved",
    },
    idempotencyKey: statusEffectKey,
    initialLedgerEntry: {
      effect_type: "zendesk_status_set",
      target_system: SourceSystem.ZENDESK,
      target_resource_id: `ticket/${ticketId}`,
      effect_key: statusEffectKey,
      attempt_number: 1,
      outcome_status: EffectOutcomeStatus.INTENDED,
      provider_correlation_id: null,
      intended_at: now,
      sent_at: null,
      confirmed_at: null,
    },
  });

  // Effect 2: Post resolution comment (if provided)
  // Retry class: AUTO_RETRY_WITH_DEDUPE
  if (commentBody) {
    const commentHash = sha256(commentBody).slice(0, 8);
    const commentEffectKey = buildEffectKey(
      executionId,
      "zendesk_comment_post",
      `ticket/${ticketId}`,
      commentHash
    );

    effects.push({
      targetSystem: SourceSystem.ZENDESK,
      payload: {
        operation: "post_comment",
        zendesk_ticket_id: ticketId,
        comment_body: commentBody,
        comment_hash: commentHash,
      },
      idempotencyKey: commentEffectKey,
      initialLedgerEntry: {
        effect_type: "zendesk_comment_post",
        target_system: SourceSystem.ZENDESK,
        target_resource_id: `ticket/${ticketId}`,
        effect_key: commentEffectKey,
        attempt_number: 1,
        outcome_status: EffectOutcomeStatus.INTENDED,
        provider_correlation_id: null,
        intended_at: now,
        sent_at: null,
        confirmed_at: null,
      },
    });
  }

  return effects;
}

function buildEscalateMissingEffects(
  executionId: string,
  params: Record<string, unknown>,
  now: string
): PlannedEffect[] {
  const ticketId = params.zendesk_ticket_id as string;
  const escalationComment =
    (params.escalation_comment as string) ??
    "This case requires additional information to resolve. Our team is reviewing.";

  const commentHash = sha256(escalationComment).slice(0, 8);
  const commentEffectKey = buildEffectKey(
    executionId,
    "zendesk_comment_post",
    `ticket/${ticketId}`,
    commentHash
  );

  return [
    {
      targetSystem: SourceSystem.ZENDESK,
      payload: {
        operation: "post_comment",
        zendesk_ticket_id: ticketId,
        comment_body: escalationComment,
        comment_hash: commentHash,
      },
      idempotencyKey: commentEffectKey,
      initialLedgerEntry: {
        effect_type: "zendesk_comment_post",
        target_system: SourceSystem.ZENDESK,
        target_resource_id: `ticket/${ticketId}`,
        effect_key: commentEffectKey,
        attempt_number: 1,
        outcome_status: EffectOutcomeStatus.INTENDED,
        provider_correlation_id: null,
        intended_at: now,
        sent_at: null,
        confirmed_at: null,
      },
    },
  ];
}

function buildUpdatePendingEffects(
  executionId: string,
  params: Record<string, unknown>,
  now: string
): PlannedEffect[] {
  const ticketId = params.zendesk_ticket_id as string;
  const statusEffectKey = buildEffectKey(
    executionId,
    "zendesk_status_set",
    `ticket/${ticketId}`
  );

  return [
    {
      targetSystem: SourceSystem.ZENDESK,
      payload: {
        operation: "update_ticket_status",
        zendesk_ticket_id: ticketId,
        target_status: "pending",
      },
      idempotencyKey: statusEffectKey,
      initialLedgerEntry: {
        effect_type: "zendesk_status_set",
        target_system: SourceSystem.ZENDESK,
        target_resource_id: `ticket/${ticketId}`,
        effect_key: statusEffectKey,
        attempt_number: 1,
        outcome_status: EffectOutcomeStatus.INTENDED,
        provider_correlation_id: null,
        intended_at: now,
        sent_at: null,
        confirmed_at: null,
      },
    },
  ];
}

function buildPostCommentEffects(
  executionId: string,
  params: Record<string, unknown>,
  now: string
): PlannedEffect[] {
  const ticketId = params.zendesk_ticket_id as string;
  const commentBody = params.comment_body as string;
  const commentHash = sha256(commentBody).slice(0, 8);
  const commentEffectKey = buildEffectKey(
    executionId,
    "zendesk_comment_post",
    `ticket/${ticketId}`,
    commentHash
  );

  return [
    {
      targetSystem: SourceSystem.ZENDESK,
      payload: {
        operation: "post_comment",
        zendesk_ticket_id: ticketId,
        comment_body: commentBody,
        comment_hash: commentHash,
      },
      idempotencyKey: commentEffectKey,
      initialLedgerEntry: {
        effect_type: "zendesk_comment_post",
        target_system: SourceSystem.ZENDESK,
        target_resource_id: `ticket/${ticketId}`,
        effect_key: commentEffectKey,
        attempt_number: 1,
        outcome_status: EffectOutcomeStatus.INTENDED,
        provider_correlation_id: null,
        intended_at: now,
        sent_at: null,
        confirmed_at: null,
      },
    },
  ];
}

function buildNotifyApprovalEffects(
  executionId: string,
  params: Record<string, unknown>,
  now: string
): PlannedEffect[] {
  const ticketId = params.zendesk_ticket_id as string;
  const managerGroupId = params.manager_group_id as string;
  const notifyEffectKey = buildEffectKey(
    executionId,
    "zendesk_comment_post",
    `ticket/${ticketId}`,
    "approval_request"
  );

  return [
    {
      targetSystem: SourceSystem.ZENDESK,
      payload: {
        operation: "post_comment",
        zendesk_ticket_id: ticketId,
        comment_body:
          "This case has been escalated for manager review. A response is required before it can proceed.",
        manager_group_id: managerGroupId,
        is_internal: true,
      },
      idempotencyKey: notifyEffectKey,
      initialLedgerEntry: {
        effect_type: "zendesk_comment_post",
        target_system: SourceSystem.ZENDESK,
        target_resource_id: `ticket/${ticketId}`,
        effect_key: notifyEffectKey,
        attempt_number: 1,
        outcome_status: EffectOutcomeStatus.INTENDED,
        provider_correlation_id: null,
        intended_at: now,
        sent_at: null,
        confirmed_at: null,
      },
    },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a deterministic deduplication key.
 * action_execution_id + effect_type + target_resource_id [+ content_hash]
 */
export function buildEffectKey(
  executionId: string,
  effectType: string,
  targetResourceId: string,
  contentHash?: string
): string {
  const parts = [executionId, effectType, targetResourceId];
  if (contentHash) parts.push(contentHash);
  return parts.join(":");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
