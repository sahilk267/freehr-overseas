/**
 * Policy Engine for Automated Approvals
 *
 * Defines the JSON shape stored in `policyConfig.autoApprovalRules` and evaluates
 * incoming approval candidates against workspace policy rules.
 *
 * Documented JSON Shape:
 * ```json
 * {
 *   "autoApprovalRules": [
 *     {
 *       "actionType": "invoice_issue",
 *       "conditions": [
 *         { "field": "amount", "op": "lte", "value": 50000 },
 *         { "field": "tier", "op": "in", "value": ["standard", "priority"] }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * Rule Evaluation Semantics:
 * - A rule matches if and only if `rule.actionType === actionType` AND every condition in `rule.conditions`
 *   evaluates to true against the provided `payload`.
 * - Supported condition operators:
 *   - "eq": Strict equality (`payload[field] === value`)
 *   - "lte": Numeric less-than-or-equal (`payload[field] <= value`)
 *   - "gte": Numeric greater-than-or-equal (`payload[field] >= value`)
 *   - "in": Membership test (`Array.isArray(value) && value.includes(payload[field])`)
 * - Fail-safe defaults:
 *   - If `policyConfig` is null, undefined, empty, or invalid JSON, returns false.
 *   - If no rule matches, returns false (human review required).
 *   - If any required field in `payload` is missing, undefined, or type-mismatched, the condition fails (returns false).
 *   - Never throws an uncaught exception on malformed or unexpected data.
 */

export type RuleOperator = "eq" | "lte" | "gte" | "in";

export interface RuleCondition {
  field: string;
  op: RuleOperator;
  value: unknown;
}

export interface AutoApprovalRule {
  id?: string;
  name?: string;
  actionType: string;
  conditions: RuleCondition[];
  graceMinutes?: number;
  delayMinutes?: number;
}

export interface PolicyConfig {
  autoApprovalRules?: AutoApprovalRule[];
  delayedActions?: Record<string, number | boolean | { graceMinutes?: number; delayMinutes?: number }> | string[];
  delayBeforeExecuting?: Record<string, number | boolean | { graceMinutes?: number; delayMinutes?: number }> | string[];
  delayedExecution?: Record<string, number | boolean | { graceMinutes?: number; delayMinutes?: number }> | string[];
  actionDelays?: Record<string, number>;
  graceMinutes?: number;
  defaultGraceMinutes?: number;
  [key: string]: unknown;
}

function evaluateCondition(
  condition: unknown,
  payload: Record<string, unknown>,
): boolean {
  if (!condition || typeof condition !== "object") return false;
  const { field, op, value } = condition as RuleCondition;

  if (typeof field !== "string" || !field) return false;
  if (!payload || typeof payload !== "object") return false;

  // Fail-safe: missing or undefined field fails condition
  if (!(field in payload) || payload[field] === undefined) {
    return false;
  }

  const actual = payload[field];

  switch (op) {
    case "eq":
      return actual === value;

    case "lte": {
      if (
        typeof actual !== "number" ||
        typeof value !== "number" ||
        Number.isNaN(actual) ||
        Number.isNaN(value)
      ) {
        return false;
      }
      return actual <= value;
    }

    case "gte": {
      if (
        typeof actual !== "number" ||
        typeof value !== "number" ||
        Number.isNaN(actual) ||
        Number.isNaN(value)
      ) {
        return false;
      }
      return actual >= value;
    }

    case "in": {
      if (!Array.isArray(value)) return false;
      return value.includes(actual);
    }

    default:
      return false;
  }
}

export function findMatchingRule(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>,
): AutoApprovalRule | null {
  try {
    if (!policyConfig) {
      return null;
    }

    let parsedConfig: unknown = policyConfig;
    if (typeof policyConfig === "string") {
      try {
        parsedConfig = JSON.parse(policyConfig);
      } catch {
        return null;
      }
    }

    if (!parsedConfig || typeof parsedConfig !== "object") {
      return null;
    }

    const rules = (parsedConfig as PolicyConfig).autoApprovalRules;
    if (!Array.isArray(rules) || rules.length === 0) {
      return null;
    }

    if (typeof actionType !== "string" || !actionType) {
      return null;
    }

    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      if (rule.actionType !== actionType) continue;

      const conditions = rule.conditions;
      if (!Array.isArray(conditions)) continue;

      const allPassed = conditions.every((cond) =>
        evaluateCondition(cond, payload),
      );

      if (allPassed) {
        return rule;
      }
    }

    return null;
  } catch {
    // Fail-safe: never throw or silently approve on corrupted structures
    return null;
  }
}

export function evaluateAutoApproval(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>,
): boolean {
  return findMatchingRule(policyConfig, actionType, payload) !== null;
}

/**
 * Returns the grace period in minutes if the actionType is marked as
 * "delay before executing" in the policy configuration.
 * Returns null if the action should be executed immediately.
 */
export function getPolicyGraceMinutes(
  policyConfig: unknown,
  actionType: string,
  matchedRule?: AutoApprovalRule | null,
): number | null {
  try {
    if (!policyConfig && !matchedRule) return null;

    let parsedConfig: Record<string, unknown> | null = null;
    if (typeof policyConfig === "string") {
      try {
        parsedConfig = JSON.parse(policyConfig);
      } catch {
        parsedConfig = null;
      }
    } else if (policyConfig && typeof policyConfig === "object") {
      parsedConfig = policyConfig as Record<string, unknown>;
    }

    // 1. Check rule-level configuration first
    if (matchedRule) {
      const ruleGrace = (matchedRule as { graceMinutes?: number; delayMinutes?: number }).graceMinutes ??
        (matchedRule as { graceMinutes?: number; delayMinutes?: number }).delayMinutes;
      if (typeof ruleGrace === "number" && Number.isFinite(ruleGrace) && ruleGrace > 0) {
        return Math.max(1, Math.round(ruleGrace));
      }
    }

    if (!parsedConfig || typeof parsedConfig !== "object") return null;

    // 2. Default workspace grace minutes (if flagged as delayed without an explicit number)
    const defaultGrace =
      typeof parsedConfig.defaultGraceMinutes === "number" && parsedConfig.defaultGraceMinutes > 0
        ? Math.max(1, Math.round(parsedConfig.defaultGraceMinutes))
        : typeof parsedConfig.graceMinutes === "number" && parsedConfig.graceMinutes > 0
        ? Math.max(1, Math.round(parsedConfig.graceMinutes))
        : 15;

    // 3. Inspect delay containers
    const delayContainers = [
      parsedConfig.delayedActions,
      parsedConfig.delayBeforeExecuting,
      parsedConfig.delayedExecution,
      parsedConfig.actionDelays,
    ];

    for (const container of delayContainers) {
      if (!container) continue;

      if (Array.isArray(container)) {
        if (container.includes(actionType)) {
          return defaultGrace;
        }
      } else if (typeof container === "object") {
        const val = (container as Record<string, unknown>)[actionType];
        if (typeof val === "number" && Number.isFinite(val) && val > 0) {
          return Math.max(1, Math.round(val));
        }
        if (typeof val === "object" && val !== null) {
          const nested = (val as { graceMinutes?: number; delayMinutes?: number; minutes?: number });
          const nestedMinutes = nested.graceMinutes ?? nested.delayMinutes ?? nested.minutes;
          if (typeof nestedMinutes === "number" && Number.isFinite(nestedMinutes) && nestedMinutes > 0) {
            return Math.max(1, Math.round(nestedMinutes));
          }
        }
        if (val === true) {
          return defaultGrace;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
