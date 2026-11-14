import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvals,
  automationQueue,
  policyVersions,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { policyLabCatalog, simulatePolicy } from "./policyLab";
import {
  findMatchingRule,
  inspectPolicyRules,
  getPolicyGraceMinutes,
} from "./policyEngine";
import { getConsequentialActionDefinition } from "../workflow";
const fixtures: Awaited<ReturnType<typeof followupFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0))
    await f.db
      .update(workspaceSettings)
      .set({ backgroundEnabled: false })
      .where(eq(workspaceSettings.ownerId, f.ownerId));
});
async function fixture() {
  const f = await followupFixture();
  fixtures.push(f);
  await f.db
    .update(workspaceSettings)
    .set({ backgroundEnabled: false })
    .where(eq(workspaceSettings.ownerId, f.ownerId));
  return f;
}
const hypothetical = {
  policySource: "what_if" as const,
  subject: "hypothetical" as const,
  actionType: "email_send",
  payloadJson: '{"amount":2}',
  configJson:
    '{"autoApprovalRules":[{"actionType":"email_send","conditions":[{"field":"amount","op":"lte","value":3}],"graceMinutes":5}]}',
};
describe("shared policy predicate diagnostics", () => {
  it.each(["eq", "lte", "gte", "in"])(
    "shares first-match semantics for %s without values",
    op => {
      const value = op === "in" ? [2, 3] : 2,
        rule = {
          actionType: "email_send",
          conditions: [{ field: "secret", op, value }],
        },
        config = {
          autoApprovalRules: [
            { actionType: "other", conditions: [] },
            rule,
            { actionType: "email_send", conditions: [] },
          ],
        };
      const trace = inspectPolicyRules(config, "email_send", { secret: 2 });
      expect(trace.matchedRule).toBe(
        findMatchingRule(config, "email_send", { secret: 2 })
      );
      expect(trace.matchedIndex).toBe(1);
      expect(trace.visitedRules).toBe(2);
      expect(trace.rules[1].conditions[0]).not.toHaveProperty("value");
    }
  );
  it("rejects inherited and nonfinite fields with the same live predicate", () => {
    const c = {
      autoApprovalRules: [
        { actionType: "x", conditions: [{ field: "x", op: "lte", value: 3 }] },
      ],
    };
    for (const p of [Object.create({ x: 1 }), { x: -Infinity }, { x: NaN }]) {
      expect(findMatchingRule(c, "x", p)).toBeNull();
      expect(inspectPolicyRules(c, "x", p).matchedRule).toBeNull();
    }
  });
  it("separates unvisited conditions from capped evaluated traces", () => {
    const condition = { field: "x", op: "eq", value: 1 };
    let r = inspectPolicyRules(
      {
        autoApprovalRules: [
          {
            actionType: "x",
            conditions: [condition, ...Array(100).fill(condition)],
          },
        ],
      },
      "x",
      { x: 0 }
    );
    expect(r.rules[0]).toMatchObject({
      conditionsVisited: 1,
      conditionsNotVisited: 100,
      conditionsOmitted: 0,
    });
    expect(r.traceTruncated).toBe(false);
    r = inspectPolicyRules(
      {
        autoApprovalRules: [
          { actionType: "x", conditions: Array(60).fill(condition) },
        ],
      },
      "x",
      { x: 1 }
    );
    expect(r.rules[0]).toMatchObject({
      conditionsVisited: 60,
      conditionsOmitted: 10,
    });
    expect(r.traceTruncated).toBe(true);
  });
  it("keeps evaluating beyond 100 trace rows to the actual first match", () => {
    const rule = { actionType: "x", conditions: [] };
    const c = {
      autoApprovalRules: [
        ...Array(101).fill({ actionType: "y", conditions: [] }),
        rule,
      ],
    };
    const r = inspectPolicyRules(c, "x", {});
    expect(r.matchedRule).toBe(rule);
    expect(r.matchedIndex).toBe(101);
    expect(r.rules).toHaveLength(100);
    expect(r.traceTruncated).toBe(true);
  });
  it.each([null, [], 0, "bad"])(
    "fails malformed payload %j even with an unconditional rule",
    p =>
      expect(
        findMatchingRule(
          { autoApprovalRules: [{ actionType: "x", conditions: [] }] },
          "x",
          p as any
        )
      ).toBeNull()
  );
  it("does not resolve inherited registry actions and bounds nonfinite default grace", () => {
    expect(getConsequentialActionDefinition("constructor")).toBeNull();
    expect(
      getPolicyGraceMinutes(
        { defaultGraceMinutes: Infinity, delayedActions: ["x"] },
        "x"
      )
    ).toBe(15);
  });
});
describe("read-only owner policy lab", () => {
  it("simulates legacy email policy while preserving mandatory human actions", async () => {
    const f = await fixture();
    const r = await simulatePolicy(f.ownerId, hypothetical);
    expect(r.result).toMatchObject({
      routing: "policy_rule_matches",
      supportedEffect: true,
      mandatoryHuman: false,
      effectiveAutomaticGraceMinutes: 5,
      executionAuthorized: false,
    });
    const c = JSON.parse(hypothetical.configJson);
    c.autoApprovalRules[0].actionType = "invoice_issue";
    const human = await simulatePolicy(f.ownerId, {
      ...hypothetical,
      actionType: "invoice_issue",
      configJson: JSON.stringify(c),
    });
    expect(human.result).toMatchObject({
      routing: "human_review_required",
      mandatoryHuman: true,
      ruleMatched: true,
      effectiveAutomaticGraceMinutes: null,
    });
    expect(
      await f.db
        .select()
        .from(approvals)
        .where(eq(approvals.ownerId, f.ownerId))
    ).toHaveLength(0);
    expect(
      await f.db
        .select()
        .from(automationQueue)
        .where(eq(automationQueue.ownerId, f.ownerId))
    ).toHaveLength(0);
  });
  it("keeps unknown action matches distinct from supported effects", async () => {
    const f = await fixture();
    const r = await simulatePolicy(f.ownerId, {
      ...hypothetical,
      actionType: "constructor",
      configJson:
        '{"autoApprovalRules":[{"actionType":"constructor","conditions":[]}]}',
    });
    expect(r.result).toMatchObject({
      ruleMatched: true,
      supportedEffect: false,
      routing: "unregistered_action",
      effectiveAutomaticGraceMinutes: null,
    });
  });
  it("uses actual current config and compares an owned saved version without activation", async () => {
    const f = await fixture(),
      id = createId("pol_");
    await f.db
      .insert(policyVersions)
      .values({
        id,
        ownerId: f.ownerId,
        createdById: f.ownerId,
        version: 1,
        name: "Synthetic saved policy",
        status: "draft",
        content: JSON.parse(hypothetical.configJson),
      });
    const current = await simulatePolicy(f.ownerId, {
      policySource: "current",
      subject: "hypothetical",
      actionType: "email_send",
    });
    expect(current.policy.isCurrentContent).toBe(true);
    expect(current.result.ruleMatched).toBe(false);
    const saved = await simulatePolicy(f.ownerId, {
      policySource: "saved",
      policyId: id,
      subject: "hypothetical",
      actionType: "email_send",
      payloadJson: '{"amount":1}',
    });
    expect(saved.policy).toMatchObject({
      source: "saved",
      status: "draft",
      isCurrentContent: false,
    });
    expect(saved.result.ruleMatched).toBe(true);
    const other = await fixture();
    await expect(
      simulatePolicy(other.ownerId, {
        policySource: "saved",
        policyId: id,
        subject: "hypothetical",
        actionType: "email_send",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("inspects stored payload privately and separates matching and mismatched recorded job scopes", async () => {
    const f = await fixture(),
      id = createId("apr_");
    await f.db
      .insert(approvals)
      .values({
        id,
        ownerId: f.ownerId,
        actionType: "email_send",
        resourceType: "emailDraft",
        resourceId: "fake-draft",
        payload: { amount: 2, secret: "PRIVATE_PAYLOAD_SENTINEL" },
        reason: "PRIVATE_REASON_SENTINEL",
      });
    for (const [i, resourceId] of ["fake-draft", "wrong-draft"].entries())
      await f.db
        .insert(automationQueue)
        .values({
          id: createId("q_"),
          ownerId: f.ownerId,
          jobType: "execute_policy_decision",
          idempotencyKey: createId("qk_"),
          scheduledAt: new Date(),
          payload: {
            approvalId: id,
            actionType: "email_send",
            resourceType: "emailDraft",
            resourceId,
            secret: "PRIVATE_QUEUE_SENTINEL",
          },
          attempts: i,
        });
    const r = await simulatePolicy(f.ownerId, {
      policySource: "what_if",
      configJson: hypothetical.configJson,
      subject: "approval",
      approvalId: id,
    });
    expect(r.result.ruleMatched).toBe(true);
    expect(
      r.existingPolicyJobs.map(j => j.scopeMatchesStoredApproval).sort()
    ).toEqual([false, true]);
    for (const secret of [
      "PRIVATE_PAYLOAD_SENTINEL",
      "PRIVATE_REASON_SENTINEL",
      "PRIVATE_QUEUE_SENTINEL",
    ])
      expect(JSON.stringify(r)).not.toContain(secret);
    const catalog = await policyLabCatalog(f.ownerId);
    expect(catalog.approvalTotal).toBe(1);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE_");
    expect(catalog.approvals[0]).not.toHaveProperty("payload");
    const other = await fixture();
    await expect(
      simulatePolicy(other.ownerId, {
        policySource: "current",
        subject: "approval",
        approvalId: id,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("returns quiet-window context without granting recipient exceptions", async () => {
    const f = await fixture();
    await f.db
      .update(workspaceSettings)
      .set({
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59",
        emergencyStop: true,
      })
      .where(eq(workspaceSettings.ownerId, f.ownerId));
    const r = await simulatePolicy(f.ownerId, hypothetical);
    expect(r.workspace).toMatchObject({
      emergencyStop: true,
      contactWindow: {
        scope: "workspace_only",
        exceptionGranted: false,
        recipientRulesEvaluated: false,
      },
    });
    expect(r.sideEffectsPerformed).toBe(false);
  });
  it.each([
    "[]",
    "null",
    '{"x":1e400}',
    JSON.stringify({
      x: { x: { x: { x: { x: { x: { x: { x: { x: 1 } } } } } } } },
    }),
  ])("rejects invalid input %s", async payloadJson => {
    const f = await fixture();
    await expect(
      simulatePolicy(f.ownerId, { ...hypothetical, payloadJson })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("rejects stored-subject overrides and out-of-range time", async () => {
    const f = await fixture();
    await expect(
      simulatePolicy(f.ownerId, {
        ...hypothetical,
        subject: "approval",
        approvalId: "fake",
      })
    ).rejects.toBeDefined();
    await expect(
      simulatePolicy(f.ownerId, { ...hypothetical, at: "2000-01-01T00:00:00Z" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("protects private endpoints from anonymous callers", async () => {
    const f = await fixture();
    const { appRouter } = await import("../routers");
    const anonymous = appRouter.createCaller({
      user: null,
      req: { headers: {} },
      res: {},
    } as any);
    await expect(anonymous.policyLab.catalog()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anonymous.policyLab.simulate(hypothetical)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
