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
  delayedActions?:
    | Record<
        string,
        number | boolean | { graceMinutes?: number; delayMinutes?: number }
      >
    | string[];
  delayBeforeExecuting?:
    | Record<
        string,
        number | boolean | { graceMinutes?: number; delayMinutes?: number }
      >
    | string[];
  delayedExecution?:
    | Record<
        string,
        number | boolean | { graceMinutes?: number; delayMinutes?: number }
      >
    | string[];
  actionDelays?: Record<string, number>;
  graceMinutes?: number;
  defaultGraceMinutes?: number;
  [key: string]: unknown;
}

export interface PolicyConditionTrace {
  field: string | null;
  operator: string | null;
  actualType: string;
  expectedType: string;
  passed: boolean;
  code: string;
}
const valueType = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
/** The live predicate and diagnostic trace share this single evaluation path. Values are never copied to the trace. */
function conditionResult(
  condition: unknown,
  payload: Record<string, unknown>
): PolicyConditionTrace {
  const base = {
    field: null as string | null,
    operator: null as string | null,
    actualType: "unavailable",
    expectedType: "unavailable",
    passed: false,
    code: "invalid_condition",
  };
  if (!condition || typeof condition !== "object") return base;
  const { field, op, value } = condition as RuleCondition;
  if (typeof field !== "string" || !field)
    return { ...base, code: "invalid_field" };
  const trace = {
    ...base,
    field: field.slice(0, 160),
    operator: typeof op === "string" ? op.slice(0, 32) : null,
    expectedType: valueType(value),
  };
  if (
    !Object.prototype.hasOwnProperty.call(payload, field) ||
    payload[field] === undefined
  )
    return { ...trace, code: "missing_own_field" };
  const actual = payload[field];
  trace.actualType = valueType(actual);
  if (
    (typeof actual === "number" && !Number.isFinite(actual)) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    return { ...trace, code: "non_finite_number" };
  let passed = false;
  switch (op) {
    case "eq":
      passed = actual === value;
      break;
    case "lte":
    case "gte":
      if (typeof actual !== "number" || typeof value !== "number")
        return { ...trace, code: "numeric_type_mismatch" };
      passed = op === "lte" ? actual <= value : actual >= value;
      break;
    case "in":
      if (!Array.isArray(value))
        return { ...trace, code: "membership_requires_array" };
      passed = value.includes(actual);
      break;
    default:
      return { ...trace, code: "unknown_operator" };
  }
  return { ...trace, passed, code: passed ? "matched" : "comparison_failed" };
}
export interface PolicyRuleTrace {
  index: number;
  status: string;
  unconditional: boolean;
  conditions: PolicyConditionTrace[];
  conditionCount: number;
  conditionsVisited: number;
  conditionsNotVisited: number;
  conditionsOmitted: number;
}
export interface PolicyInspection {
  status: string;
  matchedRule: AutoApprovalRule | null;
  matchedIndex: number | null;
  ruleCount: number;
  visitedRules: number;
  traceTruncated: boolean;
  rules: PolicyRuleTrace[];
}
function inspectRules(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>,
  collect: boolean
): PolicyInspection {
  const result: PolicyInspection = {
    status: "no_matching_rule",
    matchedRule: null,
    matchedIndex: null,
    ruleCount: 0,
    visitedRules: 0,
    traceTruncated: false,
    rules: [],
  };
  try {
    if (!policyConfig) return { ...result, status: "no_policy" };
    let parsed: unknown = policyConfig;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { ...result, status: "invalid_policy_json" };
      }
    }
    if (!parsed || typeof parsed !== "object")
      return { ...result, status: "invalid_policy_shape" };
    if (typeof actionType !== "string" || !actionType)
      return { ...result, status: "invalid_action" };
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { ...result, status: "invalid_payload_shape" };
    const rules = (parsed as PolicyConfig).autoApprovalRules;
    if (!Array.isArray(rules) || !rules.length)
      return { ...result, status: "no_rules" };
    result.ruleCount = rules.length;
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      result.visitedRules++;
      const trace: PolicyRuleTrace = {
        index,
        status: "invalid_rule",
        unconditional: false,
        conditions: [],
        conditionCount: 0,
        conditionsVisited: 0,
        conditionsNotVisited: 0,
        conditionsOmitted: 0,
      };
      const retain = collect && result.rules.length < 100;
      if (rule && typeof rule === "object") {
        if (rule.actionType !== actionType) trace.status = "different_action";
        else {
          const conditions = rule.conditions;
          if (!Array.isArray(conditions)) trace.status = "invalid_conditions";
          else {
            trace.conditionCount = conditions.length;
            trace.unconditional = conditions.length === 0;
            let all = true,
              visited = 0;
            for (const cond of conditions) {
              const test = conditionResult(cond, payload);
              visited++;
              if (retain && trace.conditions.length < 50)
                trace.conditions.push(test);
              if (!test.passed) {
                all = false;
                break;
              }
            }
            trace.conditionsVisited = visited;
            trace.conditionsNotVisited = conditions.length - visited;
            trace.conditionsOmitted = visited - trace.conditions.length;
            trace.status = all ? "matched" : "condition_failed";
            if (all) {
              result.status = "matched";
              result.matchedRule = rule;
              result.matchedIndex = index;
            }
          }
        }
      }
      if (retain) result.rules.push(trace);
      if (collect && (!retain || trace.conditionsOmitted > 0))
        result.traceTruncated = true;
      if (result.matchedRule) break;
    }
    return result;
  } catch {
    return {
      ...result,
      status: "evaluation_error",
      matchedRule: null,
      matchedIndex: null,
    };
  }
}
export function inspectPolicyRules(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>
): PolicyInspection {
  return inspectRules(policyConfig, actionType, payload, true);
}
export function findMatchingRule(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>
): AutoApprovalRule | null {
  return inspectRules(policyConfig, actionType, payload, false).matchedRule;
}

export function evaluateAutoApproval(
  policyConfig: unknown,
  actionType: string,
  payload: Record<string, unknown>
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
  matchedRule?: AutoApprovalRule | null
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
      const ruleGrace =
        (matchedRule as { graceMinutes?: number; delayMinutes?: number })
          .graceMinutes ??
        (matchedRule as { graceMinutes?: number; delayMinutes?: number })
          .delayMinutes;
      if (
        typeof ruleGrace === "number" &&
        Number.isFinite(ruleGrace) &&
        ruleGrace > 0
      ) {
        return Math.max(1, Math.round(ruleGrace));
      }
    }

    if (!parsedConfig || typeof parsedConfig !== "object") return null;

    // 2. Default workspace grace minutes (if flagged as delayed without an explicit number)
    const defaultGrace =
      typeof parsedConfig.defaultGraceMinutes === "number" &&
      Number.isFinite(parsedConfig.defaultGraceMinutes) &&
      parsedConfig.defaultGraceMinutes > 0
        ? Math.max(1, Math.round(parsedConfig.defaultGraceMinutes))
        : typeof parsedConfig.graceMinutes === "number" &&
            Number.isFinite(parsedConfig.graceMinutes) &&
            parsedConfig.graceMinutes > 0
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
          const nested = val as {
            graceMinutes?: number;
            delayMinutes?: number;
            minutes?: number;
          };
          const nestedMinutes =
            nested.graceMinutes ?? nested.delayMinutes ?? nested.minutes;
          if (
            typeof nestedMinutes === "number" &&
            Number.isFinite(nestedMinutes) &&
            nestedMinutes > 0
          ) {
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
