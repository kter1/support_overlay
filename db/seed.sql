-- ============================================================================
-- IISL Phase 1 — Demo Seed Data
-- Provides three demo scenarios + one approvals demo scenario
-- Run after 001_initial_schema.sql
-- ============================================================================

-- ─── Demo Tenant ─────────────────────────────────────────────────────────────

INSERT INTO tenants (id, name, subdomain) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Support Co', 'acme');

INSERT INTO tenant_config (
  tenant_id,
  approvals_enabled,
  evidence_freshness_seconds,
  refund_amount_tolerance_pct,
  reopen_gate_count,
  manager_approval_threshold_cents,
  manager_approval_group_id,
  zendesk_subdomain
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  false,   -- approvals OFF by default
  300,     -- 5-minute freshness window
  2.0,
  3,
  5000,    -- $50.00 threshold
  'managers-group-123',
  'acme'
);

INSERT INTO tenant_integrations (tenant_id, source_system, use_simulator) VALUES
  ('00000000-0000-0000-0000-000000000001', 'zendesk', true),
  ('00000000-0000-0000-0000-000000000001', 'stripe',  true),
  ('00000000-0000-0000-0000-000000000001', 'shopify', true);

-- ─── Scenario 1: Happy Path — Refund Confirmed ───────────────────────────────
-- Ticket 10001: High-confidence match, refund succeeded in Stripe
-- Expected demo: agent sees CLOSE button, clicks it, issue resolves in <3s

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'cust_happy_001',
   'alice@example.com',
   'OPEN');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   '10001', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'stripe', 're_happy_001', 'v1',
   '{"id":"re_happy_001","amount":4999,"currency":"usd","status":"succeeded","charge":"ch_001","created":1704067200}'),
  ('20000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'shopify', 'order_happy_001', 'v1',
   '{"id":"order_happy_001","name":"#1001","financial_status":"refunded","fulfillment_status":"fulfilled","total_price":"49.99","currency":"USD","created_at":"2024-01-01T00:00:00Z"}');

INSERT INTO evidence_normalized (
  tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data, fetched_at, is_source_unavailable
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'stripe', 're_happy_001',
   '20000000-0000-0000-0000-000000000001',
   'v1',
   '{"stripeRefundId":"re_happy_001","stripeRefundStatus":"succeeded","stripeChargeAmount":4999,"stripeCurrency":"usd","refundAmount":4999,"refundCurrency":"usd"}',
   now(), false),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'shopify', 'order_happy_001',
   '20000000-0000-0000-0000-000000000002',
   'v1',
   '{"shopifyOrderId":"order_happy_001","shopifyOrderName":"#1001","shopifyFinancialStatus":"refunded","shopifyFulfillmentStatus":"fulfilled","shopifyOrderTotal":4999,"shopifyOrderCurrency":"USD"}',
   now(), false);

INSERT INTO evidence_match_results (
  tenant_id, issue_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'v1', 'HIGH', 0.94,
   ARRAY['refund_amount','currency','financial_status'],
   'Stripe refund and Shopify order amounts match within tolerance. Financial status confirms refund posted.');

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   '10001', 'OPEN', 'HIGH', 0.94, now(), false,
   '{"stripeRefundStatus":"succeeded","stripeChargeAmount":4999,"shopifyOrderName":"#1001","shopifyFinancialStatus":"refunded","refundAmount":4999,"currency":"usd"}');

-- ─── Scenario 2: Degraded Mode — Source Unavailable ──────────────────────────
-- Ticket 10002: Shopify order archived. Stripe data present but Shopify unavailable.
-- Expected demo: agent sees soft warning, PROCEED option still available

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'cust_degraded_001',
   'bob@example.com',
   'OPEN');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   '10002', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'stripe', 're_degraded_001', 'v1',
   '{"id":"re_degraded_001","amount":7500,"currency":"usd","status":"pending","charge":"ch_002","created":1704067200}'),
  ('20000000-0000-0000-0000-000000000004',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'shopify', 'order_archived_001', 'v1',
   null);  -- raw_data nulled because source is archived

-- Mark Shopify snapshot raw data as unavailable
UPDATE evidence_raw_snapshots
SET raw_data_redaction_reason = 'source_archived'
WHERE id = '20000000-0000-0000-0000-000000000004';

INSERT INTO evidence_normalized (
  tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data, fetched_at, is_source_unavailable, source_unavailable_reason
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'stripe', 're_degraded_001',
   '20000000-0000-0000-0000-000000000003',
   'v1',
   '{"stripeRefundId":"re_degraded_001","stripeRefundStatus":"pending","stripeChargeAmount":7500,"stripeCurrency":"usd","refundAmount":7500,"refundCurrency":"usd"}',
   now(), false, null),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'shopify', 'order_archived_001',
   '20000000-0000-0000-0000-000000000004',
   'v1',
   '{}',  -- no usable normalized data
   now(), true, 'Shopify order archived — last known state unavailable. Verify via Shopify admin if needed.');

INSERT INTO evidence_match_results (
  tenant_id, issue_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'v1', 'MEDIUM', 0.71,
   ARRAY['refund_amount'],
   'Stripe data available. Shopify order no longer accessible — match based on Stripe evidence only.');

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   '10002', 'OPEN', 'MEDIUM', 0.71, now(), true,
   '{"stripeRefundStatus":"pending","stripeChargeAmount":7500,"refundAmount":7500,"currency":"usd","sourceUnavailable":true,"sourceUnavailableReason":"Shopify order archived — last known state unavailable. Verify via Shopify admin if needed."}');

-- ─── Scenario 3: Retry + Unknown Outcome ─────────────────────────────────────
-- Ticket 10003: Action was taken, outbox message reached SENT_UNCERTAIN state
-- Expected demo: shows retrying state, operator can reconcile

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000001',
   'cust_retry_001',
   'carol@example.com',
   'ACTION_IN_PROGRESS');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   '10003', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'stripe', 're_retry_001', 'v1',
   '{"id":"re_retry_001","amount":3000,"currency":"usd","status":"succeeded","charge":"ch_003","created":1704067200}');

INSERT INTO evidence_normalized (
  tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data, fetched_at, is_source_unavailable
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'stripe', 're_retry_001',
   '20000000-0000-0000-0000-000000000005',
   'v1',
   '{"stripeRefundId":"re_retry_001","stripeRefundStatus":"succeeded","stripeChargeAmount":3000,"stripeCurrency":"usd","refundAmount":3000,"refundCurrency":"usd"}',
   now(), false);

INSERT INTO evidence_match_results (
  tenant_id, issue_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'v1', 'HIGH', 0.91,
   ARRAY['refund_amount','refund_status'],
   'Stripe refund confirmed succeeded. High confidence match.');

-- Action execution that is in FAILED_RETRIABLE (will be picked up by worker demo)
INSERT INTO action_executions (
  id, tenant_id, issue_id, action_type, requested_by_agent_id,
  idempotency_key, planned_state, status, attempt_count, next_attempt_at,
  policy_rule_id, policy_version
) VALUES
  ('30000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'close_confirmed', 'agent-demo-001',
   'demo-idempotency-close-10003', 'RESOLVED',
   'FAILED_RETRIABLE', 2, now() + interval '30 seconds',
   'refund.close_confirmed.high_match', 'v1');

-- Outbox message with SENT_UNCERTAIN effects ledger entry
INSERT INTO outbox_messages (
  id, tenant_id, action_execution_id, target_system, payload,
  idempotency_key, status, attempt_count, effects
) VALUES
  ('40000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001',
   'zendesk',
   '{"type":"set_status","ticket_id":"10003","status":"solved"}',
   'demo-outbox-close-10003',
   'FAILED_RETRIABLE', 2,
   '[
     {
       "effect_type": "zendesk_status_set",
       "target_system": "zendesk",
       "target_resource_id": "ticket/10003",
       "effect_key": "exec-30000000-close_confirmed-ticket/10003",
       "attempt_number": 1,
       "outcome_status": "SENT_UNCERTAIN",
       "provider_correlation_id": null,
       "intended_at": "2024-01-01T10:00:00Z",
       "sent_at": "2024-01-01T10:00:01Z",
       "confirmed_at": null
     },
     {
       "effect_type": "zendesk_status_set",
       "target_system": "zendesk",
       "target_resource_id": "ticket/10003",
       "effect_key": "exec-30000000-close_confirmed-ticket/10003",
       "attempt_number": 2,
       "outcome_status": "SENT_UNCERTAIN",
       "provider_correlation_id": null,
       "intended_at": "2024-01-01T10:01:00Z",
       "sent_at": "2024-01-01T10:01:01Z",
       "confirmed_at": null
     }
   ]'::jsonb);

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, pending_action_execution_id,
  last_action_type, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   '10003', 'ACTION_IN_PROGRESS', 'HIGH', 0.91, now(), false,
   '30000000-0000-0000-0000-000000000001',
   'close_confirmed',
   '{"stripeRefundStatus":"succeeded","stripeChargeAmount":3000,"refundAmount":3000,"currency":"usd"}');

-- ─── Audit log entries for demo ───────────────────────────────────────────────

INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, actor_id, payload, policy_rule_id, policy_version)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'policy_decision', 'agent', 'agent-demo-001',
   '{"outcome":"ALLOW","action_type":"close_confirmed","match_band":"HIGH"}',
   'refund.close_confirmed.high_match', 'v1'),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'action_execution_created', 'system', 'system',
   '{"action_execution_id":"30000000-0000-0000-0000-000000000001","action_type":"close_confirmed"}',
   null, null),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'action_execution_retry', 'system', 'system',
   '{"action_execution_id":"30000000-0000-0000-0000-000000000001","attempt":2,"outcome_status":"SENT_UNCERTAIN"}',
   null, null);
