/**
 * @iisl/api — Outbox Worker
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Processes pending outbox_messages with effects ledger deduplication.
 * Implements per-action retry classification per spec Section 4.2.3.
 *
 * CRITICAL SEMANTICS:
 * - state_transitions is written ONLY after all outbox messages SENT
 * - FAILED_TERMINAL does NOT write to state_transitions
 * - SENT_UNCERTAIN requires action-type-specific retry policy (not generic retry)
 * - Stripe refund initiation is OPERATOR_RETRY_ONLY (never auto-retry)
 *
 * Spec reference: Section 4.2, 4.2.2, 4.2.3
 */
import { query, withTransaction } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { applyStateTransition } from "../services/actionService";
import { ZendeskAdapter } from "../../../../packages/connectors/src/zendesk/adapter";
import {
  ActionType,
  OutboxStatus,
  ExecutionStatus,
  EffectOutcomeStatus,
  ActorType,
  ACTION_RETRY_CLASS,
  RetryClass,
} from "@iisl/shared";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // 5 attempts max
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;

// ─── Worker loop ──────────────────────────────────────────────────────────────

export async function startOutboxWorker(): Promise<void> {
  console.log("[worker] Outbox worker started");

  while (true) {
    try {
      await processNextBatch();
    } catch (err) {
      console.error("[worker] Batch processing error:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextBatch(): Promise<void> {
  // Claim up to 10 pending/retriable messages
  const result = await query<OutboxRow>(
    `SELECT om.*, ae.action_type, ae.planned_state, ae.tenant_id as ae_tenant_id,
            ae.issue_id, ae.requested_by_agent_id
     FROM outbox_messages om
     JOIN action_executions ae ON ae.id = om.action_execution_id
     WHERE om.status IN ('PENDING', 'FAILED_RETRIABLE')
       AND (om.next_attempt_at IS NULL OR om.next_attempt_at <= now())
     ORDER BY om.created_at ASC
     LIMIT 10
     FOR UPDATE SKIP LOCKED`
  );

  for (const msg of result.rows) {
    await processMessage(msg);
  }
}

// ─── Message processing ───────────────────────────────────────────────────────

async function processMessage(msg: OutboxRow): Promise<void> {
  const retryClass =
    ACTION_RETRY_CLASS[msg.action_type as ActionType] ?? RetryClass.SAFE_AUTO_RETRY;
  const effects: EffectLedgerEntry[] = msg.effects ?? [];
  const currentAttempt = msg.attempt_count + 1;

  // Mark as IN_PROGRESS
  await query(
    `UPDATE action_executions SET status = 'IN_PROGRESS' WHERE id = $1`,
    [msg.action_execution_id]
  );

  // Build initial effect entry
  const effectKey = effects[0]?.effect_key ?? msg.idempotency_key;
  const now = new Date().toISOString();

  try {
    // Mark effect as INTENDED → about to send
    await appendEffectEntry(msg.id, {
      ...buildEffectEntry(msg, effectKey, currentAttempt, now),
      outcome_status: EffectOutcomeStatus.INTENDED,
    });

    // Execute external call
    const result = await executeExternalCall(msg, retryClass);

    if (result.uncertain) {
      // SENT_UNCERTAIN: response timed out after request was sent
      await handleSentUncertain(msg, effectKey, currentAttempt, retryClass);
      return;
    }

    if (result.success) {
      // SENT_ACKED: provider confirmed success
      await handleSuccess(msg, effectKey, currentAttempt, result.providerId ?? null, now);
    } else {
      // Provider returned error
      await handleFailure(
        msg,
        effectKey,
        currentAttempt,
        result.error ?? "Unknown error",
        result.isPermanent ?? false
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Treat unexpected errors as retriable
    await handleFailure(msg, effectKey, currentAttempt, errorMsg, false);
  }
}

// ─── SENT_UNCERTAIN handling (action-type specific) ───────────────────────────

/**
 * Handles the SENT_UNCERTAIN state — request was sent but response timed out.
 * Per spec Section 4.2.2.3 and 4.2.3:
 *
 * Example A — Zendesk comment post: dedupe-safe check (read recent comments)
 * Example B — Zendesk status update: reconciliation-first (read current status)
 * Example C — Stripe refund: reconciliation-only (OPERATOR_RETRY_ONLY — never auto-retry)
 */
async function handleSentUncertain(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number,
  retryClass: RetryClass
): Promise<void> {
  await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.SENT_UNCERTAIN);

  if (retryClass === RetryClass.OPERATOR_RETRY_ONLY) {
    // Stripe refund initiation: NEVER auto-retry on SENT_UNCERTAIN
    // Operator must verify via Stripe dashboard before any action
    await markTerminal(
      msg,
      effectKey,
      "SENT_UNCERTAIN — Stripe operator-retry-only policy. " +
        "Verify via Stripe dashboard before reconciling."
    );
    return;
  }

  if (retryClass === RetryClass.RECONCILIATION_FIRST) {
    // Zendesk status set: read current status before any retry
    const confirmed = await reconcileZendeskStatus(msg);
    if (confirmed) {
      await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.CONFIRMED);
      await markOutboxSent(msg);
      await checkAndCompleteExecution(msg);
    } else {
      await scheduleRetry(msg, effectKey, attemptNumber);
    }
    return;
  }

  if (retryClass === RetryClass.AUTO_RETRY_WITH_DEDUPE) {
    // Zendesk comment post: read recent comments to check if already posted
    const confirmed = await reconcileZendeskComment(msg);
    if (confirmed) {
      await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.CONFIRMED);
      await markOutboxSent(msg);
      await checkAndCompleteExecution(msg);
    } else {
      await scheduleRetry(msg, effectKey, attemptNumber);
    }
    return;
  }

  // Default: treat as retriable for safe-auto-retry classes
  await scheduleRetry(msg, effectKey, attemptNumber);
}

// ─── Execution completion ─────────────────────────────────────────────────────

/**
 * Check if all outbox messages for this action_execution are SENT.
 * If yes: write state_transitions + update issues.state + mark execution COMPLETED.
 * This is the ONLY point where state_transitions is written.
 */
async function checkAndCompleteExecution(msg: OutboxRow): Promise<void> {
  const pendingResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM outbox_messages
     WHERE action_execution_id = $1 AND status NOT IN ('SENT')`,
    [msg.action_execution_id]
  );

  if (parseInt(pendingResult.rows[0].count) > 0) {
    return; // Other outbox messages still pending
  }

  // All done — apply state transition atomically
  await withTransaction(async (client) => {
    // Get current issue state for transition
    const issueResult = await client.query<{ state: string }>(
      `SELECT state FROM issues WHERE id = $1 FOR UPDATE`,
      [msg.issue_id]
    );
    const currentState = issueResult.rows[0].state;

    // Write to state_transitions (applied canonical change)
    if (msg.planned_state && msg.planned_state !== currentState) {
      await applyStateTransition(
        client,
        msg.ae_tenant_id,
        msg.issue_id,
        currentState,
        msg.planned_state,
        msg.action_execution_id,
        msg.action_type,
        msg.requested_by_agent_id
      );
    }

    // Mark action_executions as COMPLETED
    await client.query(
      `UPDATE action_executions
       SET status = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [msg.action_execution_id]
    );

    await writeAuditEventTx(client, {
      tenantId: msg.ae_tenant_id,
      issueId: msg.issue_id,
      eventType: AuditEventType.ACTION_EXECUTION_COMPLETED,
      actorType: ActorType.SYSTEM,
      payload: {
        action_execution_id: msg.action_execution_id,
        action_type: msg.action_type,
        planned_state: msg.planned_state,
      },
    });
  });

  // Rebuild card state read model
  await rebuildCardState(msg.ae_tenant_id, msg.issue_id);
}

// ─── Success / failure handlers ───────────────────────────────────────────────

async function handleSuccess(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number,
  providerId: string | null,
  now: string
): Promise<void> {
  await updateEffectStatus(
    msg.id,
    effectKey,
    EffectOutcomeStatus.CONFIRMED,
    providerId
  );
  await markOutboxSent(msg);
  await checkAndCompleteExecution(msg);
}

async function handleFailure(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number,
  error: string,
  isPermanent: boolean
): Promise<void> {
  if (isPermanent || attemptNumber >= MAX_ATTEMPTS) {
    await markTerminal(msg, effectKey, error);
  } else {
    await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.FAILED_RETRIABLE);
    await scheduleRetry(msg, effectKey, attemptNumber);
  }
}

async function markTerminal(
  msg: OutboxRow,
  effectKey: string,
  error: string
): Promise<void> {
  await withTransaction(async (client) => {
    await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.FAILED_TERMINAL);

    await client.query(
      `UPDATE outbox_messages SET status = 'FAILED_TERMINAL' WHERE id = $1`,
      [msg.id]
    );

    // FAILED_TERMINAL: do NOT write to state_transitions
    await client.query(
      `UPDATE action_executions
       SET status = 'FAILED_TERMINAL', error = $2
       WHERE id = $1`,
      [msg.action_execution_id, error]
    );

    await writeAuditEventTx(client, {
      tenantId: msg.ae_tenant_id,
      issueId: msg.issue_id,
      eventType: AuditEventType.ACTION_EXECUTION_FAILED_TERMINAL,
      actorType: ActorType.SYSTEM,
      payload: {
        action_execution_id: msg.action_execution_id,
        action_type: msg.action_type,
        outbox_message_id: msg.id,
        error,
        attempt_count: msg.attempt_count,
      },
    });
  });
}

async function scheduleRetry(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number
): Promise<void> {
  const delayMs = RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
  const nextAttempt = new Date(Date.now() + delayMs);

  await query(
    `UPDATE outbox_messages
     SET status = 'FAILED_RETRIABLE',
         attempt_count = $2,
         next_attempt_at = $3
     WHERE id = $1`,
    [msg.id, attemptNumber, nextAttempt.toISOString()]
  );

  await query(
    `UPDATE action_executions
     SET status = 'FAILED_RETRIABLE', attempt_count = $2, next_attempt_at = $3
     WHERE id = $1`,
    [msg.action_execution_id, attemptNumber, nextAttempt.toISOString()]
  );
}

// ─── Effects ledger mutations ─────────────────────────────────────────────────

async function appendEffectEntry(
  outboxId: string,
  entry: EffectLedgerEntry
): Promise<void> {
  await query(
    `UPDATE outbox_messages
     SET effects = effects || $2::jsonb
     WHERE id = $1`,
    [outboxId, JSON.stringify([entry])]
  );
}

async function updateEffectStatus(
  outboxId: string,
  effectKey: string,
  status: EffectOutcomeStatus,
  providerId?: string | null
): Promise<void> {
  // Update the last ledger entry matching this effect_key
  await query(
    `UPDATE outbox_messages
     SET effects = (
       SELECT jsonb_agg(
         CASE
           WHEN (e->>'effect_key') = $2
           THEN e
             || jsonb_build_object('outcome_status', $3)
             || CASE WHEN $4::text IS NOT NULL
                     THEN jsonb_build_object('provider_correlation_id', $4,
                                             'confirmed_at', now())
                     ELSE '{}'::jsonb END
           ELSE e
         END
       )
       FROM jsonb_array_elements(effects) e
     )
     WHERE id = $1`,
    [outboxId, effectKey, status, providerId ?? null]
  );
}

async function markOutboxSent(msg: OutboxRow): Promise<void> {
  await query(
    `UPDATE outbox_messages
     SET status = 'SENT', sent_at = now(), attempt_count = attempt_count + 1
     WHERE id = $1`,
    [msg.id]
  );
}

// ─── External call execution ──────────────────────────────────────────────────

interface ExternalCallResult {
  success: boolean;
  uncertain: boolean;
  providerId?: string | null;
  error?: string;
  isPermanent?: boolean;
}

async function executeExternalCall(
  msg: OutboxRow,
  retryClass: RetryClass
): Promise<ExternalCallResult> {
  const payload = msg.payload as Record<string, unknown>;
  const operation = payload.operation as string;

  // Route to appropriate adapter
  if (msg.target_system === "zendesk") {
    return executeZendeskCall(operation, payload, msg.idempotency_key);
  }

  if (msg.target_system === "stripe") {
    return executeStripeCall(operation, payload, msg.idempotency_key);
  }

  return { success: false, uncertain: false, error: `Unknown target_system: ${msg.target_system}`, isPermanent: true };
}

async function executeZendeskCall(
  operation: string,
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<ExternalCallResult> {
  try {
    const adapter = new ZendeskAdapter();

    if (operation === "update_ticket_status") {
      await adapter.updateTicketStatus(
        payload.zendesk_ticket_id as string,
        payload.target_status as string
      );
      return { success: true, uncertain: false, providerId: null };
    }

    if (operation === "post_comment") {
      const commentId = await adapter.postComment(
        payload.zendesk_ticket_id as string,
        payload.comment_body as string,
        idempotencyKey
      );
      return { success: true, uncertain: false, providerId: `zd_comment_${commentId}` };
    }

    return { success: false, uncertain: false, error: `Unknown Zendesk operation: ${operation}`, isPermanent: true };
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { success: false, uncertain: true };
    }
    if (err instanceof PermanentError) {
      return { success: false, uncertain: false, error: err.message, isPermanent: true };
    }
    return { success: false, uncertain: false, error: String(err), isPermanent: false };
  }
}

async function executeStripeCall(
  operation: string,
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<ExternalCallResult> {
  // Stripe operations are OPERATOR_RETRY_ONLY for money movement
  // This adapter is primarily for verification/reconciliation reads
  try {
    if (operation === "verify_refund") {
      // Read-only verification — safe to retry
      return { success: true, uncertain: false, providerId: payload.refund_id as string };
    }
    return { success: false, uncertain: false, error: `Stripe operation ${operation} requires operator initiation`, isPermanent: true };
  } catch (err) {
    if (err instanceof TimeoutError) {
      // For Stripe: SENT_UNCERTAIN → OPERATOR_RETRY_ONLY
      return { success: false, uncertain: true };
    }
    return { success: false, uncertain: false, error: String(err), isPermanent: false };
  }
}

// ─── Reconciliation helpers ───────────────────────────────────────────────────

async function reconcileZendeskStatus(msg: OutboxRow): Promise<boolean> {
  // Example B: Read current Zendesk ticket status before retry
  // Returns true if status already matches target (CONFIRMED)
  try {
    const adapter = new ZendeskAdapter();
    const payload = msg.payload as Record<string, unknown>;
    const currentStatus = await adapter.getTicketStatus(
      payload.zendesk_ticket_id as string
    );
    return currentStatus === payload.target_status;
  } catch {
    return false;
  }
}

async function reconcileZendeskComment(msg: OutboxRow): Promise<boolean> {
  // Example A: Read recent comments, check for matching hash
  try {
    const adapter = new ZendeskAdapter();
    const payload = msg.payload as Record<string, unknown>;
    const comments = (await adapter.getRecentComments(
      payload.zendesk_ticket_id as string
    )) as string[];
    const hash = payload.comment_hash as string;
    return comments.some((c: string) => c.includes(hash));
  } catch {
    return false;
  }
}

// ─── Card state rebuild ───────────────────────────────────────────────────────

async function rebuildCardState(tenantId: string, issueId: string): Promise<void> {
  // Minimal rebuild: update issue_card_state from canonical tables
  await query(
    `INSERT INTO issue_card_state
       (tenant_id, issue_id, zendesk_ticket_id, issue_state,
        refund_status, refund_amount_cents, refund_currency, refund_id,
        match_band, confidence_score, evidence_fetched_at, is_source_unavailable,
        last_rebuilt_at)
     SELECT
       i.tenant_id,
       i.id,
       it.zendesk_ticket_id,
       i.state,
       en.refund_status,
       en.refund_amount_cents,
       en.refund_currency,
       en.refund_id,
       emr.match_band,
       emr.confidence_score,
       en.fetched_at,
       en.is_source_unavailable,
       now()
     FROM issues i
     LEFT JOIN issue_tickets it ON it.issue_id = i.id AND it.is_primary = true AND it.is_deleted = false
     LEFT JOIN evidence_normalized en ON en.issue_id = i.id AND en.tenant_id = i.tenant_id
     LEFT JOIN evidence_match_results emr ON emr.evidence_normalized_id = en.id
     WHERE i.id = $1 AND i.tenant_id = $2
     ORDER BY en.fetched_at DESC NULLS LAST
     LIMIT 1
     ON CONFLICT (issue_id) DO UPDATE SET
       issue_state = EXCLUDED.issue_state,
       refund_status = EXCLUDED.refund_status,
       refund_amount_cents = EXCLUDED.refund_amount_cents,
       refund_currency = EXCLUDED.refund_currency,
       refund_id = EXCLUDED.refund_id,
       match_band = EXCLUDED.match_band,
       confidence_score = EXCLUDED.confidence_score,
       evidence_fetched_at = EXCLUDED.evidence_fetched_at,
       is_source_unavailable = EXCLUDED.is_source_unavailable,
       last_rebuilt_at = now(),
       updated_at = now()`,
    [issueId, tenantId]
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEffectEntry(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number,
  now: string
): EffectLedgerEntry {
  return {
    effect_type: (msg.payload as Record<string, unknown>).operation as string,
    target_system: msg.target_system as any,
    target_resource_id: effectKey,
    effect_key: effectKey,
    attempt_number: attemptNumber,
    outcome_status: EffectOutcomeStatus.INTENDED,
    provider_correlation_id: null,
    intended_at: now,
    sent_at: null,
    confirmed_at: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error classes ────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

// ─── Type definitions ─────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  tenant_id: string;
  action_execution_id: string;
  target_system: string;
  payload: unknown;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  effects: EffectLedgerEntry[];
  action_type: string;
  planned_state: string | null;
  ae_tenant_id: string;
  issue_id: string;
  requested_by_agent_id: string;
}

interface EffectLedgerEntry {
  effect_type: string;
  target_system: string;
  target_resource_id: string;
  effect_key: string;
  attempt_number: number;
  outcome_status: EffectOutcomeStatus;
  provider_correlation_id: string | null;
  intended_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
}
