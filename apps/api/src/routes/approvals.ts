/**
 * @iisl/api — Approval Routes
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Approval flow is present but disabled by default (tenant_config.approvals_enabled = false).
 * When disabled: these endpoints return 403 with explanation.
 * When enabled: full approval lifecycle runs.
 *
 * POST /api/v1/approvals/:approval_id/grant
 * POST /api/v1/approvals/:approval_id/deny
 * GET  /api/v1/approvals/:approval_id
 *
 * Idempotency enforced by:
 * 1. Schema: UNIQUE partial index on action_executions(approval_request_id)
 * 2. Transaction: atomic status check + execution creation
 */
import { FastifyInstance } from "fastify";
import { query, withTransaction } from "../db/pool";
import { completeApprovalAndEnqueue } from "../services/actionService";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { ActorType } from "@iisl/shared";

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/approvals/:approval_id
   * Check status of an approval request.
   */
  app.get<{ Params: { approval_id: string } }>(
    "/:approval_id",
    async (request, reply) => {
      const tenantId = request.headers["x-tenant-id"] as string;
      if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

      const result = await query(
        `SELECT ar.*, ae.status as execution_status
         FROM approval_requests ar
         LEFT JOIN action_executions ae ON ae.id = ar.linked_action_execution_id
         WHERE ar.id = $1 AND ar.tenant_id = $2`,
        [request.params.approval_id, tenantId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Approval request not found" });
      }

      return reply.send(result.rows[0]);
    }
  );

  /**
   * POST /api/v1/approvals/:approval_id/grant
   * Manager grants an approval. Creates action_executions row atomically.
   *
   * Idempotency invariant: if an action_executions row already exists for
   * this approval_request_id, the unique index prevents a second insert.
   */
  app.post<{
    Params: { approval_id: string };
    Body: { manager_id: string };
  }>("/:approval_id/grant", async (request, reply) => {
    const tenantId = request.headers["x-tenant-id"] as string;
    if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

    // Check approvals_enabled
    const configResult = await query<{ approvals_enabled: boolean }>(
      "SELECT approvals_enabled FROM tenant_config WHERE tenant_id = $1",
      [tenantId]
    );

    if (!configResult.rows[0]?.approvals_enabled) {
      return reply.status(403).send({
        error: "Approval flow is not enabled for this tenant",
        hint: "Set tenant_config.approvals_enabled = true to enable approval flows",
      });
    }

    const { manager_id } = request.body;
    if (!manager_id) {
      return reply.status(400).send({ error: "manager_id is required" });
    }

    try {
      const executionId = await completeApprovalAndEnqueue(
        tenantId,
        request.params.approval_id,
        manager_id
      );

      return reply.status(200).send({
        outcome: "APPROVED",
        action_execution_id: executionId,
        correlation_id: request.correlationId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("expired")) {
        return reply.status(409).send({ error: msg });
      }
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /api/v1/approvals/:approval_id/deny
   * Manager denies an approval. No action_executions row created.
   */
  app.post<{
    Params: { approval_id: string };
    Body: { manager_id: string; reason?: string };
  }>("/:approval_id/deny", async (request, reply) => {
    const tenantId = request.headers["x-tenant-id"] as string;
    if (!tenantId) return reply.status(401).send({ error: "x-tenant-id required" });

    const configResult = await query<{ approvals_enabled: boolean }>(
      "SELECT approvals_enabled FROM tenant_config WHERE tenant_id = $1",
      [tenantId]
    );

    if (!configResult.rows[0]?.approvals_enabled) {
      return reply.status(403).send({ error: "Approval flow is not enabled" });
    }

    const { manager_id, reason } = request.body;

    await withTransaction(async (client) => {
      const result = await client.query<{ issue_id: string }>(
        `UPDATE approval_requests
         SET status = 'DENIED', denied_at = now(),
             assigned_manager_id = $2, reason = $3
         WHERE id = $1 AND tenant_id = $4 AND status = 'PENDING'
         RETURNING issue_id`,
        [request.params.approval_id, manager_id, reason ?? null, tenantId]
      );

      if (result.rows.length === 0) {
        throw new Error("Approval not found or already resolved");
      }

      await writeAuditEventTx(client, {
        tenantId,
        issueId: result.rows[0].issue_id,
        eventType: AuditEventType.APPROVAL_DENIED,
        actorType: ActorType.AGENT,
        actorId: manager_id,
        payload: {
          approval_request_id: request.params.approval_id,
          reason,
        },
      });
    });

    return reply.send({
      outcome: "DENIED",
      correlation_id: request.correlationId,
    });
  });
}
