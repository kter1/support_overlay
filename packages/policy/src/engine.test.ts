/**
 * @iisl/policy — Policy Engine Tests
 * VALIDATION: [COMPILE-PENDING] — run with: npm test (from packages/policy)
 *
 * Covers spec Section 5.4 test contract:
 * - Matrix coverage (one test per rule)
 * - Precedence tests
 * - Catch-all default behavior
 * - Approval toggle enforcement
 * - DENY vs REQUIRES_APPROVAL vs ALLOW separation
 * - policy_rule_id emission for every evaluation
 */

import { describe, it, expect } from "vitest";
import { evaluate, ACTION_RISK_TIERS } from "./engine";
import {
  PolicyOutcome,
  ActionType,
  DegradedState,
  AbuseSeverity,
  ActionRiskTier,
} from "@iisl/shared";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const baseTenantConfig = {
  evidenceFreshnessSeconds: 300,
  amountMatchTolerancePct: 2,
  reopenGateCount: 3,
  managerApprovalThresholdCents: 5000,
  managerApprovalGroupId: null,
  approvalsEnabled: false,   // pilot default: OFF
  macroPrefixResolved: "",
  macroPrefixPending: "",
};

const baseInput = {
  tenantId: "tenant-1",
  issueId: "issue-1",
  agentId: "agent-1",
  degradedState: DegradedState.NOMINAL,
  abuseSeverity: AbuseSeverity.NONE,
  context: { refundAmountCents: 1000, evidenceFresh: true, matchBand: "HIGH" },
  tenantConfig: baseTenantConfig,
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<typeof baseInput> = {}) {
  return { ...baseInput, ...overrides };
}

// ─── Audit contract: policy_rule_id always present ────────────────────────────

describe("audit contract", () => {
  it("emits a non-null policyRuleId for every evaluation", () => {
    for (const actionType of Object.values(ActionType)) {
      const result = evaluate(makeInput({ actionType }));
      expect(result.policyRuleId).toBeTruthy();
      expect(result.policyVersion).toBeTruthy();
    }
  });
});

// ─── Approval toggle enforcement ─────────────────────────────────────────────

describe("approval toggle", () => {
  it("never returns REQUIRES_APPROVAL when approvalsEnabled = false", () => {
    const input = makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: false },
      context: { refundAmountCents: 99999 }, // over threshold
    });
    const result = evaluate(input);
    expect(result.outcome).not.toBe(PolicyOutcome.REQUIRES_APPROVAL);
  });

  it("returns REQUIRES_APPROVAL for over-threshold when approvalsEnabled = true", () => {
    const input = makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: true },
      context: { refundAmountCents: 99999 }, // over threshold
      abuseSeverity: AbuseSeverity.NONE,
    });
    const result = evaluate(input);
    expect(result.outcome).toBe(PolicyOutcome.REQUIRES_APPROVAL);
    expect(result.policyRuleId).toBe("rule_amount_threshold_requires_approval");
  });
});

// ─── DENY vs REQUIRES_APPROVAL vs ALLOW separation ───────────────────────────

describe("outcome separation", () => {
  it("DENY for HIGH abuse + HIGH risk action (approvals OFF)", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      abuseSeverity: AbuseSeverity.HIGH,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: false },
    }));
    expect(result.outcome).toBe(PolicyOutcome.DENY);
    expect(result.policyRuleId).toBe("rule_abuse_high_risk_high_deny");
  });

  it("DENY for HIGH abuse + HIGH risk action (approvals ON) — DENY overrides approval check", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      abuseSeverity: AbuseSeverity.HIGH,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: true },
    }));
    expect(result.outcome).toBe(PolicyOutcome.DENY);
  });

  it("DENY has a denyReason with no accusation language", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      abuseSeverity: AbuseSeverity.HIGH,
    }));
    expect(result.outcome).toBe(PolicyOutcome.DENY);
    expect(result.denyReason).toBeTruthy();
    // Check for accusation language violations
    const forbidden = ["fraud", "fraudster", "cheat", "liar", "suspicious customer"];
    for (const word of forbidden) {
      expect(result.denyReason?.toLowerCase()).not.toContain(word);
    }
  });

  it("ALLOW for LOW risk action in any state", () => {
    for (const degraded of Object.values(DegradedState)) {
      const result = evaluate(makeInput({
        actionType: ActionType.REFRESH_EVIDENCE,
        degradedState: degraded,
        abuseSeverity: AbuseSeverity.HIGH, // even with high abuse
      }));
      expect(result.outcome).toBe(PolicyOutcome.ALLOW);
      expect(result.policyRuleId).toBe("rule_low_risk_allow");
    }
  });
});

// ─── Degraded mode matrix ─────────────────────────────────────────────────────

describe("degraded mode matrix", () => {
  it("DENY for DEGRADED_UNAVAILABLE + HIGH risk (approvals OFF → remapped to DENY)", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.DEGRADED_UNAVAILABLE,
      abuseSeverity: AbuseSeverity.NONE,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: false },
    }));
    // With approvals OFF, REQUIRES_APPROVAL remaps to DENY for HIGH risk
    expect(result.outcome).toBe(PolicyOutcome.DENY);
  });

  it("REQUIRES_APPROVAL for DEGRADED_UNAVAILABLE + HIGH risk (approvals ON)", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.DEGRADED_UNAVAILABLE,
      abuseSeverity: AbuseSeverity.NONE,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: true },
    }));
    expect(result.outcome).toBe(PolicyOutcome.REQUIRES_APPROVAL);
    expect(result.policyRuleId).toBe("rule_degraded_unavailable_high_risk");
  });

  it("ALLOW for DEGRADED_STALE + HIGH risk + no abuse", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.DEGRADED_STALE,
      abuseSeverity: AbuseSeverity.NONE,
      context: {
        refundAmountCents: 1000, // under threshold
        isSourceUnavailable: false,
      },
    }));
    expect(result.outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("isDegradedModeOverride is true for non-nominal states (non-trivial actions)", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.DEGRADED_STALE,
      abuseSeverity: AbuseSeverity.NONE,
      context: { refundAmountCents: 1000 },
    }));
    expect(result.isDegradedModeOverride).toBe(true);
  });
});

// ─── Tombstone semantics ──────────────────────────────────────────────────────

describe("tombstone / source unavailable", () => {
  it("DENY for SOURCE_TOMBSTONED + HIGH risk", () => {
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.SOURCE_TOMBSTONED,
      abuseSeverity: AbuseSeverity.NONE,
      context: { isSourceUnavailable: true, refundAmountCents: 1000 },
    }));
    expect(result.outcome).toBe(PolicyOutcome.DENY);
    expect(result.policyRuleId).toBe("rule_tombstone_high_risk_deny");
  });
});

// ─── Catch-all default ────────────────────────────────────────────────────────

describe("catch-all default", () => {
  it("never silently returns REQUIRES_APPROVAL when approvals disabled", () => {
    // Simulate unmatched combination by using all catch-all defaults
    const result = evaluate(makeInput({
      actionType: ActionType.CLOSE_CONFIRMED,
      degradedState: DegradedState.NOMINAL,
      abuseSeverity: AbuseSeverity.NONE,
      tenantConfig: { ...baseTenantConfig, approvalsEnabled: false },
      context: { refundAmountCents: 1000 },
    }));
    expect(result.outcome).not.toBe(PolicyOutcome.REQUIRES_APPROVAL);
  });
});

// ─── Risk tier assignment ─────────────────────────────────────────────────────

describe("risk tier assignment", () => {
  it("CLOSE_CONFIRMED is HIGH risk", () => {
    expect(ACTION_RISK_TIERS[ActionType.CLOSE_CONFIRMED]).toBe(ActionRiskTier.HIGH);
  });
  it("REFRESH_EVIDENCE is LOW risk", () => {
    expect(ACTION_RISK_TIERS[ActionType.REFRESH_EVIDENCE]).toBe(ActionRiskTier.LOW);
  });
  it("POST_COMMENT is LOW risk", () => {
    expect(ACTION_RISK_TIERS[ActionType.POST_COMMENT]).toBe(ActionRiskTier.LOW);
  });
});
