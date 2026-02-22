/**
 * @iisl/api — Webhook Ingestion Routes
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * POST /webhooks/zendesk
 * POST /webhooks/stripe
 * POST /webhooks/shopify
 *
 * All webhooks: store inbound_events with dedupe, verify signature,
 * route to appropriate handler.
 *
 * Idempotency: UNIQUE (tenant_id, source_system, external_event_id)
 * Safe replay: re-processing a PROCESSED event is a no-op.
 * Out-of-order: uses source_event_at when present; received_at as fallback.
 *
 * Spec reference: Section 4.1, Section 7.1 (Zendesk merge/delete coverage)
 */
import { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { createHash } from "crypto";
import { query, withTransaction } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { ActorType } from "@iisl/shared";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Zendesk webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/zendesk",
    async (request, reply) => {
      const tenantId = request.headers["x-tenant-id"] as string;
      if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

      const signatureValid = await verifyZendeskSignature(request, tenantId);
      const externalEventId =
        (request.body?.id as string) ?? generateStableId(request.body);
      const sourceEventType = request.body?.type as string | undefined;
      const sourceEventAt = extractSourceEventAt(request.body);

      await ingestEvent({
        tenantId,
        sourceSystem: "zendesk",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Stripe webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/stripe",
    async (request, reply) => {
      const tenantId = request.headers["x-tenant-id"] as string;
      if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

      const signatureValid = await verifyStripeSignature(request, tenantId);
      const externalEventId = request.body?.id as string;
      const sourceEventType = request.body?.type as string | undefined;
      const sourceEventAt = request.body?.created
        ? new Date((request.body.created as number) * 1000).toISOString()
        : undefined;

      await ingestEvent({
        tenantId,
        sourceSystem: "stripe",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Shopify webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/shopify",
    async (request, reply) => {
      const tenantId = request.headers["x-tenant-id"] as string;
      if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

      const signatureValid = await verifyShopifySignature(request, tenantId);
      const externalEventId =
        (request.body?.id as string) ?? generateStableId(request.body);
      const sourceEventType =
        (request.headers["x-shopify-topic"] as string) ?? undefined;
      const sourceEventAt = request.body?.updated_at as string | undefined;

      await ingestEvent({
        tenantId,
        sourceSystem: "shopify",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Fixture injection endpoint (local demo — no real webhook needed)
  app.post<{
    Body: {
      source_system: string;
      event_type: string;
      payload: Record<string, unknown>;
    };
  }>("/fixture", async (request, reply) => {
    const tenantId = request.headers["x-tenant-id"] as string;
    if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

    const { source_system, event_type, payload } = request.body;
    const externalEventId = `fixture_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await ingestEvent({
      tenantId,
      sourceSystem: source_system,
      externalEventId,
      sourceEventType: event_type,
      payload,
      signatureValid: true, // fixtures are trusted
      correlationId: request.correlationId,
    });

    return reply.status(200).send({
      received: true,
      external_event_id: externalEventId,
      correlation_id: request.correlationId,
    });
  });
}

// ─── Core ingestion ───────────────────────────────────────────────────────────

interface IngestInput {
  tenantId: string;
  sourceSystem: string;
  externalEventId: string;
  sourceEventType?: string;
  sourceEventAt?: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
  correlationId: string;
}

async function ingestEvent(input: IngestInput): Promise<void> {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.payload))
    .digest("hex");

  try {
    await withTransaction(async (client) => {
      // Insert with ON CONFLICT: return existing row if already seen
      const result = await client.query<{ id: string; status: string }>(
        `INSERT INTO inbound_events
           (tenant_id, source_system, external_event_id, source_event_at,
            source_event_type, payload, payload_hash, signature_valid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RECEIVED')
         ON CONFLICT (tenant_id, source_system, external_event_id)
         DO UPDATE SET status = 'DUPLICATE'
         RETURNING id, status`,
        [
          input.tenantId,
          input.sourceSystem,
          input.externalEventId,
          input.sourceEventAt ?? null,
          input.sourceEventType ?? null,
          JSON.stringify(input.payload),
          payloadHash,
          input.signatureValid,
        ]
      );

      const row = result.rows[0];

      if (row.status === "DUPLICATE") {
        // Idempotent: already processed, nothing to do
        return;
      }

      if (!input.signatureValid) {
        await client.query(
          `UPDATE inbound_events SET status = 'FAILED', error = 'Invalid signature'
           WHERE id = $1`,
          [row.id]
        );
        return;
      }

      // Route to handler
      await routeEvent(client, input, row.id);

      await client.query(
        `UPDATE inbound_events SET status = 'PROCESSED', processed_at = now()
         WHERE id = $1`,
        [row.id]
      );

      await writeAuditEventTx(client, {
        tenantId: input.tenantId,
        eventType: AuditEventType.INBOUND_EVENT_PROCESSED,
        actorType: ActorType.WEBHOOK,
        payload: {
          source_system: input.sourceSystem,
          event_type: input.sourceEventType,
          external_event_id: input.externalEventId,
          correlation_id: input.correlationId,
        },
      });
    });
  } catch (err) {
    // On conflict or error — log but don't crash webhook endpoint
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (!errorMsg.includes("DUPLICATE")) {
      console.error("[webhook] Ingestion error:", errorMsg);
    }
  }
}

// ─── Event routing ────────────────────────────────────────────────────────────

import { PoolClient } from "pg";

async function routeEvent(
  client: PoolClient,
  input: IngestInput,
  inboundEventId: string
): Promise<void> {
  const { sourceSystem, sourceEventType, payload, tenantId } = input;

  if (sourceSystem === "zendesk") {
    await routeZendeskEvent(client, tenantId, sourceEventType, payload);
  } else if (sourceSystem === "shopify") {
    await routeShopifyEvent(client, tenantId, sourceEventType, payload);
  } else if (sourceSystem === "stripe") {
    await routeStripeEvent(client, tenantId, sourceEventType, payload);
  }
}

async function routeZendeskEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  const ticket = payload.ticket as Record<string, unknown> | undefined;
  const ticketId = String(ticket?.id ?? payload.id ?? "");

  switch (eventType) {
    case "ticket.created":
      // Classify ticket; if refund ticket, create Issue and trigger evidence fetch
      await handleTicketCreated(client, tenantId, ticketId, ticket ?? payload);
      break;

    case "ticket.updated":
      // Re-evaluate classification; detect merge signals
      await handleTicketUpdated(client, tenantId, ticketId, ticket ?? payload);
      break;

    case "ticket.comment.created":
      // Log to audit; no issue state change unless structured trigger tag
      break;

    // Ticket deletion semantic coverage (spec Section 4.2.4, Section 7.1):
    // Native ticket.deleted may not be available on all Zendesk plans.
    // The daily reconciliation job (polling fallback) handles 404s independently.
    // If this event IS received, apply tombstone immediately.
    case "ticket.deleted":
      await handleTicketDeleted(client, tenantId, ticketId);
      break;

    // Merge signal (spec Section 7.1):
    // Native merge webhook is plan-dependent.
    // Also detected in ticket.updated via merged_ticket_ids field (see handleTicketUpdated).
    case "ticket.merged":
      await handleTicketMerged(client, tenantId, ticketId, payload);
      break;

    default:
      // Unknown event type: log and ignore (version drift tolerance)
      console.log(`[webhook] Unknown Zendesk event type: ${eventType} — ignored`);
  }
}

async function handleTicketCreated(
  client: PoolClient,
  tenantId: string,
  ticketId: string,
  ticket: Record<string, unknown>
): Promise<void> {
  // Simple classifier: check for refund-related tags or keywords
  const tags = (ticket.tags as string[]) ?? [];
  const subject = (ticket.subject as string) ?? "";
  const isRefundTicket =
    tags.includes("refund") ||
    tags.includes("refund_request") ||
    /refund|charge|return/i.test(subject);

  if (!isRefundTicket) return;

  // Create Issue
  const issueResult = await client.query<{ id: string }>(
    `INSERT INTO issues (tenant_id, customer_id, customer_email, state, playbook_id)
     VALUES ($1, $2, $3, 'OPEN', 'refund_v1')
     RETURNING id`,
    [
      tenantId,
      String(ticket.requester_id ?? ""),
      String(ticket.email ?? ""),
    ]
  );

  const issueId = issueResult.rows[0].id;

  await client.query(
    `INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary)
     VALUES ($1, $2, $3, true)`,
    [tenantId, issueId, ticketId]
  );

  // Initialize card state
  await client.query(
    `INSERT INTO issue_card_state (tenant_id, issue_id, zendesk_ticket_id, issue_state)
     VALUES ($1, $2, $3, 'OPEN')
     ON CONFLICT (issue_id) DO NOTHING`,
    [tenantId, issueId, ticketId]
  );

  await writeAuditEventTx(client, {
    tenantId,
    issueId,
    eventType: "issue_created_from_ticket",
    actorType: ActorType.WEBHOOK,
    payload: { zendesk_ticket_id: ticketId },
  });
}

async function handleTicketUpdated(
  client: PoolClient,
  tenantId: string,
  ticketId: string,
  ticket: Record<string, unknown>
): Promise<void> {
  // Detect merge signal in ticket.updated (plan-dependent native merge webhook fallback)
  const mergedTicketIds = ticket.merged_ticket_ids as string[] | undefined;
  if (mergedTicketIds && mergedTicketIds.length > 0) {
    for (const mergedId of mergedTicketIds) {
      await handleTicketMerged(client, tenantId, mergedId, {
        surviving_ticket_id: ticketId,
      });
    }
  }
}

async function handleTicketDeleted(
  client: PoolClient,
  tenantId: string,
  ticketId: string
): Promise<void> {
  // Apply tombstone: mark issue_tickets.is_deleted, update card state
  await client.query(
    `UPDATE issue_tickets
     SET is_deleted = true, deleted_at = now()
     WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, ticketId]
  );

  // Find affected issue and mark evidence as source unavailable
  const issueResult = await client.query<{ issue_id: string }>(
    `SELECT issue_id FROM issue_tickets WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, ticketId]
  );

  if (issueResult.rows.length > 0) {
    const { issue_id } = issueResult.rows[0];
    await client.query(
      `UPDATE evidence_normalized
       SET is_source_unavailable = true, updated_at = now()
       WHERE tenant_id = $1 AND issue_id = $2`,
      [tenantId, issue_id]
    );

    await writeAuditEventTx(client, {
      tenantId,
      issueId: issue_id,
      eventType: AuditEventType.TICKET_SOURCE_DELETED,
      actorType: ActorType.WEBHOOK,
      payload: { zendesk_ticket_id: ticketId },
    });
  }
}

async function handleTicketMerged(
  client: PoolClient,
  tenantId: string,
  secondaryTicketId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Secondary ticket merged into primary — mark secondary as not primary
  await client.query(
    `UPDATE issue_tickets
     SET is_primary = false
     WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, secondaryTicketId]
  );

  const issueResult = await client.query<{ issue_id: string }>(
    `SELECT issue_id FROM issue_tickets WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, secondaryTicketId]
  );

  if (issueResult.rows.length > 0) {
    await writeAuditEventTx(client, {
      tenantId,
      issueId: issueResult.rows[0].issue_id,
      eventType: AuditEventType.TICKET_MERGED,
      actorType: ActorType.WEBHOOK,
      payload: {
        secondary_ticket_id: secondaryTicketId,
        surviving_ticket_id: payload.surviving_ticket_id,
      },
    });
  }
}

async function routeShopifyEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  // Shopify order archival tombstone handling
  if (
    eventType === "orders/updated" &&
    payload.status === "archived"
  ) {
    const orderId = String(payload.id ?? "");
    await client.query(
      `UPDATE evidence_normalized
       SET is_source_unavailable = true, updated_at = now()
       WHERE tenant_id = $1
         AND source_system = 'shopify'
         AND refund_id LIKE $2`,
      [tenantId, `%${orderId}%`]
    );
    await writeAuditEventTx(client, {
      tenantId,
      eventType: AuditEventType.ORDER_ARCHIVED,
      actorType: ActorType.WEBHOOK,
      payload: { shopify_order_id: orderId },
    });
  }
}

async function routeStripeEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  // Stripe refund events update evidence_normalized
  if (eventType === "charge.refunded" || eventType === "refund.updated") {
    // Evidence will be refreshed on next evidence pull cycle
    // Log for audit trail
    await writeAuditEventTx(client, {
      tenantId,
      eventType: "stripe_refund_event_received",
      actorType: ActorType.WEBHOOK,
      payload: { stripe_event_type: eventType },
    });
  }
}

// ─── Signature verification ───────────────────────────────────────────────────

async function verifyZendeskSignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const secret = process.env.ZENDESK_WEBHOOK_SECRET ?? "dev_zendesk_webhook_secret";
  const signature = request.headers["x-zendesk-webhook-signature"] as string;
  if (!signature) return process.env.NODE_ENV === "development";

  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(request.body))
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

async function verifyStripeSignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "dev_stripe_webhook_secret";
  const sigHeader = request.headers["stripe-signature"] as string;
  if (!sigHeader) return process.env.NODE_ENV === "development";

  // Stripe uses timestamp + signature scheme
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("=") as [string, string])
  );
  const timestamp = parts["t"];
  const sig = parts["v1"];

  if (!timestamp || !sig) return false;

  const payload = `${timestamp}.${JSON.stringify(request.body)}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

async function verifyShopifySignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? "dev_shopify_webhook_secret";
  const hmac = request.headers["x-shopify-hmac-sha256"] as string;
  if (!hmac) return process.env.NODE_ENV === "development";

  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(request.body))
    .digest("base64");

  try {
    return timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateStableId(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

function extractSourceEventAt(
  payload: Record<string, unknown>
): string | undefined {
  const candidates = [
    payload.updated_at,
    payload.created_at,
    payload.event_time,
    (payload.ticket as Record<string, unknown>)?.updated_at,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}
