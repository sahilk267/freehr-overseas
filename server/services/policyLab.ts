import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  approvals,
  automationQueue,
  policyVersions,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  POLICY_LAB_VERSION,
  policySimulation,
  policyLabQuery,
} from "../../shared/policyLab";
import { requireDb } from "../db";
import {
  APPROVAL_SIDE_EFFECT_ACTIONS,
  CANONICAL_CONSEQUENTIAL_ACTIONS,
  CONSEQUENTIAL_ACTION_TYPES,
  getConsequentialActionDefinition,
} from "../workflow";
import { canonicalHash } from "./canonicalHash";
import { inspectPolicyRules, getPolicyGraceMinutes } from "./policyEngine";
import { nextContactTime } from "./workflowTiming";
const unsupported = (label: string) =>
  new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      label +
      " exceeds the supported inspection shape/size. Review it in the governing workflow; no partial simulation was returned.",
  });
function bound(value: unknown, limit: number, label: string) {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    throw unsupported(label);
  }
  if (Buffer.byteLength(text, "utf8") > limit) throw unsupported(label);
  let nodes = 0;
  const visit = (v: any, depth: number) => {
    if (++nodes > 8192 || depth > 8) throw unsupported(label);
    if (typeof v === "number" && !Number.isFinite(v)) throw unsupported(label);
    if (
      v === undefined ||
      typeof v === "function" ||
      typeof v === "symbol" ||
      typeof v === "bigint"
    )
      throw unsupported(label);
    if (v && typeof v === "object") {
      for (const key of Object.keys(v)) visit(v[key], depth + 1);
    }
  };
  visit(value, 0);
  return value;
}
function parseInput(text: string, label: string, limit: number) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error();
    bound(parsed, limit, label);
    const validate = (v: any) => {
      if (typeof v === "number" && !Number.isFinite(v)) throw Error();
      if (v && typeof v === "object")
        for (const key of Object.keys(v)) validate(v[key]);
    };
    validate(parsed);
    return parsed as Record<string, unknown>;
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        label +
        " must be a bounded JSON object with finite numeric values (depth ≤ 8).",
    });
  }
}
const workspaceFields = {
  automationMode: workspaceSettings.automationMode,
  emergencyStop: workspaceSettings.emergencyStop,
  backgroundEnabled: workspaceSettings.backgroundEnabled,
  businessTimezone: workspaceSettings.businessTimezone,
  quietHoursStart: workspaceSettings.quietHoursStart,
  quietHoursEnd: workspaceSettings.quietHoursEnd,
  policyConfig: workspaceSettings.policyConfig,
};
const approvalFields = {
  id: approvals.id,
  actionType: approvals.actionType,
  resourceType: approvals.resourceType,
  resourceId: approvals.resourceId,
  status: approvals.status,
  createdAt: approvals.createdAt,
  decidedAt: approvals.decidedAt,
  decisionSource: approvals.decisionSource,
};
const safeApproval = (r: any) => ({
  id: r.id,
  actionType: r.actionType,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  status: r.status,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt ?? null,
  decisionSource: r.decisionSource ?? null,
});
export async function policyLabCatalog(
  ownerId: number,
  raw?: z.input<typeof policyLabQuery>
) {
  const input = policyLabQuery.parse(raw);
  return (await requireDb()).transaction(async (tx: any) => {
    const [workspaceRows, policies, records] = await Promise.all([
      tx
        .select(workspaceFields)
        .from(workspaceSettings)
        .where(eq(workspaceSettings.ownerId, ownerId))
        .limit(1),
      tx
        .select({
          id: policyVersions.id,
          name: policyVersions.name,
          status: policyVersions.status,
          version: policyVersions.version,
        })
        .from(policyVersions)
        .where(eq(policyVersions.ownerId, ownerId))
        .orderBy(desc(policyVersions.version))
        .limit(51),
      tx
        .select(approvalFields)
        .from(approvals)
        .where(eq(approvals.ownerId, ownerId))
        .orderBy(desc(approvals.createdAt), asc(approvals.id))
        .limit(10001),
    ]);
    if (records.length > 10000) throw unsupported("Approval source");
    const workspace = workspaceRows[0];
    if (!workspace)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Workspace settings are unavailable.",
      });
    const selected = records.filter(
      (r: any) => input.status === "all" || r.status === input.status
    );
    return {
      version: POLICY_LAB_VERSION,
      workspace: {
        automationMode: workspace.automationMode,
        emergencyStop: workspace.emergencyStop === true,
        backgroundEnabled: workspace.backgroundEnabled === true,
        timezone: workspace.businessTimezone,
        quietStart: workspace.quietHoursStart,
        quietEnd: workspace.quietHoursEnd,
        currentPolicyDigest: canonicalHash(workspace.policyConfig ?? null),
      },
      legacyActions: ["email_send"],
      actions: Object.entries(CANONICAL_CONSEQUENTIAL_ACTIONS).map(
        ([key, def]) => ({
          key,
          description: def.description,
          resourceType: def.resourceType,
          allowAutoApproval: def.allowAutoApproval,
          aliasOf: def.aliasOf ?? null,
        })
      ),
      policies: policies.slice(0, 50).map((r: any) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        version: r.version,
      })),
      olderPoliciesAvailable: policies.length > 50,
      approvals: selected
        .slice(input.offset, input.offset + input.limit)
        .map(safeApproval),
      approvalTotal: selected.length,
      hasMore: input.offset + input.limit < selected.length,
      offset: input.offset,
      inspectionOnly: true,
      executionAuthorized: false,
    };
  });
}
export async function simulatePolicy(
  ownerId: number,
  raw: z.input<typeof policySimulation>
) {
  const input = policySimulation.parse(raw);
  return (await requireDb()).transaction(async (tx: any) => {
    const workspace = (
      await tx
        .select(workspaceFields)
        .from(workspaceSettings)
        .where(eq(workspaceSettings.ownerId, ownerId))
        .limit(1)
    )[0];
    if (!workspace)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Workspace settings are unavailable.",
      });
    let config: unknown = workspace.policyConfig ?? null,
      policy: {
        source: string;
        id: string | null;
        version: number | null;
        status: string | null;
      } = { source: input.policySource, id: null, version: null, status: null };
    if (input.policySource === "what_if")
      config = parseInput(input.configJson!, "Unsaved policy", 64000);
    if (input.policySource === "saved") {
      const row = (
        await tx
          .select()
          .from(policyVersions)
          .where(
            and(
              eq(policyVersions.ownerId, ownerId),
              eq(policyVersions.id, input.policyId!)
            )
          )
          .limit(1)
      )[0];
      if (!row)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Saved policy was not found in this workspace.",
        });
      config = row.content;
      policy = {
        source: "saved",
        id: row.id,
        version: row.version,
        status: row.status,
      };
    }
    bound(config, 64000, "Policy configuration");
    if (typeof config === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(config);
      } catch {
        parsed = null;
      }
      if (parsed !== null) bound(parsed, 64000, "Parsed policy configuration");
    }
    let payload: unknown,
      actionType: string,
      approval: any = null;
    if (input.subject === "approval") {
      approval = (
        await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.ownerId, ownerId),
              eq(approvals.id, input.approvalId!)
            )
          )
          .limit(1)
      )[0];
      if (!approval)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Stored approval was not found in this workspace.",
        });
      payload = approval.payload ?? {};
      bound(payload, 32000, "Stored approval payload");
      actionType = approval.actionType;
    } else {
      payload = parseInput(
        input.payloadJson ?? "{}",
        "Hypothetical payload",
        32000
      );
      actionType = input.actionType!;
    }
    const at = input.at ? new Date(input.at) : new Date();
    if (Math.abs(at.getTime() - Date.now()) > 366 * 86400000)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Simulation time must be within 366 days of the current date.",
      });
    const inspection = inspectPolicyRules(
        config,
        actionType,
        payload as Record<string, unknown>
      ),
      registered = CONSEQUENTIAL_ACTION_TYPES.has(actionType),
      definition = registered
        ? getConsequentialActionDefinition(actionType)
        : null,
      mandatoryHuman = definition?.allowAutoApproval === false;
    const matchingRuleGrace = inspection.matchedRule
      ? getPolicyGraceMinutes(config, actionType, inspection.matchedRule)
      : null;
    const supportedEffect = APPROVAL_SIDE_EFFECT_ACTIONS.has(actionType);
    const routing = !supportedEffect
      ? "unregistered_action"
      : mandatoryHuman
        ? "human_review_required"
        : inspection.matchedRule
          ? "policy_rule_matches"
          : "human_review_required";
    let nextWindow: Date | null = null,
      windowIssue: string | null = null;
    try {
      nextWindow = nextContactTime(at, {
        timezone: workspace.businessTimezone,
        quietStart: workspace.quietHoursStart,
        quietEnd: workspace.quietHoursEnd,
        businessDaysOnly: false,
      });
    } catch {
      windowIssue = "Workspace contact window is invalid or unavailable.";
    }
    let jobs: any[] = [];
    if (approval) {
      const rows = await tx
        .select({
          id: automationQueue.id,
          jobType: automationQueue.jobType,
          status: automationQueue.status,
          scheduledAt: automationQueue.scheduledAt,
          attempts: automationQueue.attempts,
          payload: automationQueue.payload,
        })
        .from(automationQueue)
        .where(
          and(
            eq(automationQueue.ownerId, ownerId),
            eq(automationQueue.jobType, "execute_policy_decision")
          )
        )
        .orderBy(desc(automationQueue.scheduledAt), asc(automationQueue.id))
        .limit(10001);
      if (rows.length > 10000) throw unsupported("Policy-job source");
      jobs = rows
        .filter((r: any) => r.payload?.approvalId === approval.id)
        .map((r: any) => ({
          id: r.id,
          status: r.status,
          scheduledAt: r.scheduledAt,
          attempts: r.attempts ?? 0,
          scopeMatchesStoredApproval:
            r.payload.actionType === approval.actionType &&
            r.payload.resourceType === approval.resourceType &&
            r.payload.resourceId === approval.resourceId,
        }));
    }
    const policyDigest = canonicalHash(config),
      payloadDigest = canonicalHash(payload),
      livePolicyDigest = canonicalHash(workspace.policyConfig ?? null);
    return {
      version: POLICY_LAB_VERSION,
      asOf: new Date().toISOString(),
      simulatedAt: at.toISOString(),
      policy: {
        ...policy,
        digest: policyDigest,
        currentWorkspaceDigest: livePolicyDigest,
        isCurrentContent: policyDigest === livePolicyDigest,
      },
      subject: {
        kind: input.subject,
        actionType,
        approval: approval ? safeApproval(approval) : null,
        payloadDigest,
        payloadWasAbsent: !!approval && approval.payload == null,
        payloadValuesReturned: false,
      },
      result: {
        routing,
        registeredAction: !!definition,
        supportedEffect,
        policyAllowsAutoApproval: definition
          ? definition.allowAutoApproval
          : true,
        canonicalAction: definition?.key ?? null,
        registeredIntent: definition?.description ?? null,
        registeredResourceType: definition?.resourceType ?? null,
        storedResourceTypeMatchesRegistry:
          approval && definition
            ? approval.resourceType === definition.resourceType
            : null,
        mandatoryHuman,
        ruleMatched: inspection.matchedRule !== null,
        matchingRuleGraceMinutes: matchingRuleGrace,
        effectiveAutomaticGraceMinutes:
          supportedEffect && !mandatoryHuman && inspection.matchedRule
            ? matchingRuleGrace
            : null,
        executionEligibilityEvaluated: false,
        executionAuthorized: false,
      },
      trace: {
        status: inspection.status,
        matchedIndex: inspection.matchedIndex,
        ruleCount: inspection.ruleCount,
        visitedRules: inspection.visitedRules,
        notVisitedRules: Math.max(
          0,
          inspection.ruleCount - inspection.visitedRules
        ),
        traceTruncated: inspection.traceTruncated,
        rules: inspection.rules,
      },
      workspace: {
        mode: workspace.automationMode,
        emergencyStop: workspace.emergencyStop === true,
        backgroundEnabled: workspace.backgroundEnabled === true,
        contactWindow: {
          scope: "workspace_only",
          timezone: workspace.businessTimezone,
          quietStart: workspace.quietHoursStart,
          quietEnd: workspace.quietHoursEnd,
          nextWorkspaceWindowAt: nextWindow?.toISOString() ?? null,
          issue: windowIssue,
          exceptionGranted: false,
          recipientRulesEvaluated: false,
        },
      },
      existingPolicyJobs: jobs.slice(0, 20),
      morePolicyJobsAvailable: jobs.length > 20,
      snapshotDigest: canonicalHash({
        policyDigest,
        payloadDigest,
        approval: approval ? safeApproval(approval) : null,
        jobs,
        at: at.toISOString(),
        workspace: {
          mode: workspace.automationMode,
          stop: workspace.emergencyStop,
          timezone: workspace.businessTimezone,
          quietStart: workspace.quietHoursStart,
          quietEnd: workspace.quietHoursEnd,
        },
      }),
      sideEffectsPerformed: false,
      limits: [
        "This is a read-only policy predicate/routing explanation. No approval, decision, queue task, grant, message, invoice or provider effect is created or changed.",
        "The registered action intent is not a preview of the exact current domain effect. Stored approval payloads may be stale; source facts, permissions, financial evidence, ownership and current resource versions are not certified here.",
        "Mandatory human requirements come from the canonical action registry and override a matching rule. A rule match does not authorize or execute an action.",
        "Saved policy versions and unsaved what-if inputs are comparison sources; the workspace's actual policy digest identifies current configuration. No policy activation occurs.",
        "Quiet windows are workspace-only observations. Recipient consent, return holds, delivery windows, quotas, suppression and channel/provider availability are not evaluated and no quiet-hour exception is issued.",
        "Matching-rule grace is hypothetical configuration. Existing policy jobs show their recorded schedule/state; the actual executor rechecks authority and effects. The simulator never starts, retries, cancels or delegates them.",
        "Traces omit values and are capped at 100 visited rules and 50 evaluated conditions per retained rule. Evaluation still stops at the actual first match; omitted/unvisited conditions are distinguished. Source sets, JSON depth and byte/node limits fail closed rather than produce partial eligibility.",
      ],
    };
  });
}
