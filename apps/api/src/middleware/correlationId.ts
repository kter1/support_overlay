/**
 * Correlation ID middleware
 * VALIDATION: [COMPILE-PENDING]
 *
 * Attaches a correlation_id to every request for log tracing.
 * Flow: inbound_event → action → outbox → audit_log all share correlation_id.
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";

export async function correlationIdMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const correlationId =
    (request.headers["x-correlation-id"] as string) ?? randomUUID();
  request.correlationId = correlationId;
  reply.header("x-correlation-id", correlationId);
}

// Extend Fastify request type
declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}
