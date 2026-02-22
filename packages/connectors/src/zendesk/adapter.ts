/**
 * @iisl/connectors — Zendesk Adapter
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Implementation note (explicit per build requirements):
 * Real API credentials are optional. When ZENDESK_API_TOKEN is not set,
 * the adapter uses the fixture simulator. This keeps the local demo runnable
 * without real Zendesk access.
 *
 * Retry class notes for callers:
 * - update_ticket_status: RECONCILIATION_FIRST
 * - post_comment: AUTO_RETRY_WITH_DEDUPE
 */

interface ZendeskComment {
  id: number;
  body: string;
  created_at: string;
}

interface ZendeskTicket {
  id: string;
  status: string;
  subject: string;
  updated_at: string;
}

export class ZendeskAdapter {
  private readonly isSimulator: boolean;
  private readonly subdomain: string;
  private readonly apiToken: string;

  constructor() {
    this.subdomain = process.env.ZENDESK_SUBDOMAIN ?? "";
    this.apiToken = process.env.ZENDESK_API_TOKEN ?? "";
    this.isSimulator = !this.apiToken;

    if (this.isSimulator) {
      console.log("[ZendeskAdapter] No credentials found — using simulator");
    }
  }

  async updateTicketStatus(
    ticketId: string,
    targetStatus: string
  ): Promise<void> {
    if (this.isSimulator) {
      return simulatorStore.updateTicketStatus(ticketId, targetStatus);
    }

    const response = await this.apiRequest(
      "PUT",
      `/api/v2/tickets/${ticketId}.json`,
      { ticket: { status: targetStatus } }
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Permanent error: Zendesk returned ${response.status}`);
      }
      throw new Error(`Retriable error: Zendesk returned ${response.status}`);
    }
  }

  async getTicketStatus(ticketId: string): Promise<string> {
    if (this.isSimulator) {
      return simulatorStore.getTicketStatus(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}.json`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch ticket ${ticketId}: ${response.status}`);
    }

    const data = (await response.json()) as { ticket: ZendeskTicket };
    return data.ticket.status;
  }

  async postComment(
    ticketId: string,
    body: string,
    idempotencyKey: string
  ): Promise<string> {
    if (this.isSimulator) {
      return simulatorStore.postComment(ticketId, body, idempotencyKey);
    }

    const response = await this.apiRequest(
      "POST",
      `/api/v2/tickets/${ticketId}/comments.json`,
      { comment: { body, public: true } },
      { "Idempotency-Key": idempotencyKey }
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Permanent error: Zendesk returned ${response.status}`);
      }
      throw new Error(`Retriable error: Zendesk returned ${response.status}`);
    }

    const data = (await response.json()) as { comment: { id: number } };
    return String(data.comment.id);
  }

  async getRecentComments(ticketId: string): Promise<string[]> {
    if (this.isSimulator) {
      return simulatorStore.getRecentComments(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}/comments.json?sort_order=desc&per_page=10`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status}`);
    }

    const data = (await response.json()) as { comments: ZendeskComment[] };
    return data.comments.map((c) => c.body);
  }

  async getTicket(ticketId: string): Promise<ZendeskTicket | null> {
    if (this.isSimulator) {
      return simulatorStore.getTicket(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}.json`
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch ticket: ${response.status}`);
    }

    const data = (await response.json()) as { ticket: ZendeskTicket };
    return data.ticket;
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = `https://${this.subdomain}.zendesk.com${path}`;
    const credentials = Buffer.from(`email@example.com/token:${this.apiToken}`).toString("base64");

    return fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000), // 10s timeout — triggers SENT_UNCERTAIN
    });
  }
}

// ─── Simulator Store (in-memory for local demo) ───────────────────────────────

class ZendeskSimulatorStore {
  private tickets = new Map<string, { status: string; subject: string }>();
  private comments = new Map<string, Array<{ body: string; idempotencyKey: string }>>();

  seed(ticketId: string, status: string, subject: string): void {
    this.tickets.set(ticketId, { status, subject });
    this.comments.set(ticketId, []);
  }

  updateTicketStatus(ticketId: string, targetStatus: string): void {
    const ticket = this.tickets.get(ticketId);
    if (ticket) {
      ticket.status = targetStatus;
    } else {
      this.tickets.set(ticketId, { status: targetStatus, subject: "Simulated ticket" });
    }
  }

  getTicketStatus(ticketId: string): string {
    return this.tickets.get(ticketId)?.status ?? "open";
  }

  postComment(ticketId: string, body: string, idempotencyKey: string): string {
    const existing = this.comments.get(ticketId) ?? [];
    // Dedupe by idempotency key
    const dupe = existing.find((c) => c.idempotencyKey === idempotencyKey);
    if (dupe) {
      return `sim_comment_${idempotencyKey.slice(-8)}`;
    }
    existing.push({ body, idempotencyKey });
    this.comments.set(ticketId, existing);
    return `sim_comment_${idempotencyKey.slice(-8)}`;
  }

  getRecentComments(ticketId: string): string[] {
    return (this.comments.get(ticketId) ?? []).map((c) => c.body);
  }

  getTicket(ticketId: string): ZendeskTicket | null {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    return {
      id: ticketId,
      status: ticket.status,
      subject: ticket.subject,
      updated_at: new Date().toISOString(),
    };
  }
}

// Singleton simulator — shared across adapter instances in tests/demo
export const simulatorStore = new ZendeskSimulatorStore();
