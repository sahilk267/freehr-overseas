import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { aiModelRoutes, aiUsage, approvals, automationQueue, candidateDocuments, candidates, contacts, conversations, matches, messages, suppressionList, workspaceSettings } from "../../drizzle/schema";
import { createId, hashContactValue, recordAudit, requireDb } from "../db";
import { OpenRouterConfigurationError, OpenRouterTransientError, OpenRouterValidationError, type AiTaskType } from "./openrouter";
import { runControlledAiTask } from "./aiRouting";
import { scanCandidateDocument } from "./documentScanner";
import { applySideEffect } from "./approvalEngine";

const AI_JOB_TYPES = new Set<AiTaskType>(["classify_reply", "draft_outreach", "parse_cv", "score_match", "send_reminder", "reconcile_invoice"]);
const calculateBackoff = (attempts: number) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
export const withinDailyAiBudget = (used: number, limit: number) => used < limit;

async function handleAiTaskResult(
  job: typeof automationQueue.$inferSelect,
  result: unknown,
  selectedModel: string,
  ownerId: number,
  db: Awaited<ReturnType<typeof requireDb>>
) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;

  if (job.jobType === "parse_cv") {
    const documentId = payload.documentId ? String(payload.documentId) : null;
    const candidateId = payload.candidateId ? String(payload.candidateId) : null;
    const parsed = result as {
      headline?: string | null;
      skills?: string[];
      totalExperienceYears?: number | null;
      recentRoles?: Array<{ title: string; employer: string | null; years: number | null }>;
      education?: string[];
      missingInformation?: string[];
      confidence?: number;
    };

    if (documentId) {
      await db
        .update(candidateDocuments)
        .set({
          parseState: "parsed",
          parsedData: parsed,
          updatedAt: new Date(),
        })
        .where(and(eq(candidateDocuments.id, documentId), eq(candidateDocuments.ownerId, ownerId)));

      if (candidateId && parsed?.headline) {
        const candidate = (
          await db
            .select()
            .from(candidates)
            .where(and(eq(candidates.id, candidateId), eq(candidates.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (candidate && !candidate.headline) {
          await db
            .update(candidates)
            .set({ headline: parsed.headline.slice(0, 255), updatedAt: new Date() })
            .where(eq(candidates.id, candidateId));
        }
      }

      await recordAudit({
        ownerId,
        actorType: "system",
        action: "candidate.document_parsed",
        resourceType: "candidate_document",
        resourceId: documentId,
        metadata: {
          candidateId,
          confidence: parsed?.confidence,
          skillsCount: parsed?.skills?.length ?? 0,
        },
      });
    }
  } else if (job.jobType === "draft_outreach") {
    const targetMessageId = payload.messageId
      ? String(payload.messageId)
      : job.idempotencyKey?.startsWith("draft_outreach:")
        ? job.idempotencyKey.replace("draft_outreach:", "")
        : null;
    const draft = result as { subject?: string; body?: string; complianceChecklist?: string[] };
    if (targetMessageId && draft?.body) {
      await db
        .update(messages)
        .set({
          subject: draft.subject ?? null,
          body: draft.body,
          status: "draft_ready",
          updatedAt: new Date(),
        })
        .where(and(eq(messages.id, targetMessageId), eq(messages.ownerId, ownerId)));

      await recordAudit({
        ownerId,
        actorType: "ai",
        actorId: selectedModel,
        action: "outreach.draft_ready",
        resourceType: "message",
        resourceId: targetMessageId,
        previousState: "drafting",
        nextState: "draft_ready",
        metadata: { complianceChecklist: draft.complianceChecklist ?? [] },
      });
    }
  } else if (job.jobType === "classify_reply") {
    const conversationId = payload.conversationId ? String(payload.conversationId) : null;
    const classificationData = result as {
      classification?: string;
      confidence?: number;
      rationale?: string;
      nextAction?: string;
    };

    if (conversationId && classificationData?.classification) {
      const isOptOut =
        classificationData.nextAction === "stop_contact" ||
        classificationData.classification === "opt_out";

      await db
        .update(conversations)
        .set({
          classification: classificationData.classification,
          status: isOptOut ? "opted_out" : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)));

      if (isOptOut) {
        if (payload.sender) {
          await db
            .insert(suppressionList)
            .values({
              id: createId("sup_"),
              ownerId,
              channel: "email",
              valueHash: hashContactValue(String(payload.sender)),
              reason: "AI classified opt-out",
              source: "ai_classify_reply",
            })
            .onDuplicateKeyUpdate({
              set: { active: true, reason: "AI classified opt-out" },
            });
        }
        const conv = (
          await db
            .select()
            .from(conversations)
            .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)))
            .limit(1)
        )[0];
        if (conv?.contactId) {
          await db
            .update(contacts)
            .set({ contactPermission: "opted_out", optedOutAt: new Date(), updatedAt: new Date() })
            .where(eq(contacts.id, conv.contactId));
        }
        if (conv?.candidateId) {
          await db
            .update(candidates)
            .set({ doNotContactAt: new Date(), updatedAt: new Date() })
            .where(eq(candidates.id, conv.candidateId));
        }
      }

      await recordAudit({
        ownerId,
        actorType: "ai",
        actorId: selectedModel,
        action: "outreach.reply_classified",
        resourceType: "conversation",
        resourceId: conversationId,
        metadata: {
          classification: classificationData.classification,
          confidence: classificationData.confidence,
          isOptOut,
        },
      });
    }
  } else if (job.jobType === "score_match") {
    const candidateId = payload.candidateId ? String(payload.candidateId) : null;
    const jobId = payload.jobId ? String(payload.jobId) : null;
    const matchScore = result as {
      ruleScore?: number;
      semanticScore?: number;
      confidence?: number;
      matchedEvidence?: string[];
      missingEvidence?: string[];
      lowConfidence?: boolean;
      recommendation?: string;
    };

    if (candidateId && jobId && matchScore) {
      const matchId = payload.matchId ? String(payload.matchId) : createId("mat_");
      const lowConf = matchScore.lowConfidence ?? (matchScore.confidence ? matchScore.confidence < 70 : false);
      await db
        .insert(matches)
        .values({
          id: matchId,
          ownerId,
          candidateId,
          jobId,
          status: lowConf ? "low_confidence" : "evidence_validated",
          ruleScore: matchScore.ruleScore ?? 0,
          semanticScore: matchScore.semanticScore ?? 0,
          confidence: matchScore.confidence ?? 0,
          evidence: matchScore.matchedEvidence ?? [],
          missingEvidence: matchScore.missingEvidence ?? [],
          lowConfidence: lowConf,
          modelRoute: selectedModel,
        })
        .onDuplicateKeyUpdate({
          set: {
            ruleScore: matchScore.ruleScore ?? 0,
            semanticScore: matchScore.semanticScore ?? 0,
            confidence: matchScore.confidence ?? 0,
            evidence: matchScore.matchedEvidence ?? [],
            missingEvidence: matchScore.missingEvidence ?? [],
            lowConfidence: lowConf,
            status: lowConf ? "low_confidence" : "evidence_validated",
            modelRoute: selectedModel,
            updatedAt: new Date(),
          },
        });

      await recordAudit({
        ownerId,
        actorType: "ai",
        actorId: selectedModel,
        action: "match.evidence_recorded",
        resourceType: "match",
        resourceId: matchId,
        metadata: {
          candidateId,
          jobId,
          lowConfidence: lowConf,
          recommendation: matchScore.recommendation,
        },
      });
    }
  }
}

export async function processOneQueuedJob(ownerId: number) {
  const db = await requireDb();
  const workspace = (await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
  if (workspace?.emergencyStop) return { status: "skipped" as const, reason: "Emergency stop is enabled." };

  const now = new Date();
  const candidates = await db
    .select()
    .from(automationQueue)
    .where(and(eq(automationQueue.ownerId, ownerId), inArray(automationQueue.status, ["queued", "retryable_failed"]), lte(automationQueue.scheduledAt, now)))
    .orderBy(asc(automationQueue.priority), asc(automationQueue.scheduledAt))
    .limit(1);
  const job = candidates[0];
  if (!job) return { status: "empty" as const };

  // AI daily budget applies only to AI inference job types, not deterministic security scans or policy executions
  if (job.jobType !== "scan_document" && job.jobType !== "execute_policy_decision") {
    const budget = Number((workspace?.policyConfig as { aiDailyLimit?: number } | null)?.aiDailyLimit ?? 45);
    const todayUsage = await db.select({ count: sql<number>`count(*)` }).from(aiUsage).where(and(eq(aiUsage.ownerId, ownerId), sql`date(${aiUsage.createdAt}) = curdate()`));
    if (!withinDailyAiBudget(todayUsage[0]?.count ?? 0, budget)) return { status: "skipped" as const, reason: `The daily AI budget of ${budget} requests has been reached.` };
  }

  const lockToken = createId("lock_");
  const claimed = await db.update(automationQueue).set({ status: "running", lockToken, lockedAt: now, attempts: job.attempts + 1 }).where(and(eq(automationQueue.id, job.id), inArray(automationQueue.status, ["queued", "retryable_failed"])));
  if (!claimed[0]?.affectedRows) return { status: "contended" as const };

  if (job.jobType === "execute_policy_decision") {
    const payload = (job.payload ?? {}) as {
      approvalId?: string;
      actionType?: string;
      resourceType?: string;
      resourceId?: string;
    };

    if (!payload.approvalId) {
      await db.update(automationQueue).set({
        status: "permanently_failed",
        lastError: "Missing approvalId in execute_policy_decision payload.",
        lockToken: null,
        lockedAt: null,
      }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      return { status: "permanently_failed" as const, jobId: job.id };
    }

    const approvalRows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, payload.approvalId), eq(approvals.ownerId, ownerId)))
      .limit(1);
    const approval = approvalRows[0];

    if (!approval) {
      await db.update(automationQueue).set({
        status: "permanently_failed",
        lastError: "Approval record not found.",
        lockToken: null,
        lockedAt: null,
      }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      return { status: "permanently_failed" as const, jobId: job.id };
    }

    if (approval.status !== "approved") {
      await db.update(automationQueue).set({
        status: "cancelled",
        completedAt: new Date(),
        lockToken: null,
        lockedAt: null,
        lastError: `Approval status is ${approval.status}; side effect not applied.`,
      }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      return { status: "completed" as const, jobId: job.id, reason: "approval_not_approved" };
    }

    try {
      const decidedAt = approval.decidedAt ?? new Date();
      const decidedById = approval.decidedById ?? ownerId;

      await applySideEffect(
        db,
        approval,
        decidedAt,
        decidedById,
      );

      await db.update(automationQueue).set({
        status: "completed",
        result: { executed: true, approvalId: approval.id, actionType: approval.actionType },
        completedAt: new Date(),
        lockToken: null,
        lockedAt: null,
        lastError: null,
      }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));

      await recordAudit({
        ownerId,
        actorType: "system",
        action: "policy.decision_executed",
        resourceType: "automation_job",
        resourceId: job.id,
        previousState: "running",
        nextState: "completed",
        metadata: {
          approvalId: approval.id,
          actionType: approval.actionType,
          resourceType: approval.resourceType,
          resourceId: approval.resourceId,
        },
      });

      return { status: "completed" as const, jobId: job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply policy decision side effect.";
      const isRetryable = job.attempts + 1 < job.maxAttempts;
      const nextStatus = isRetryable ? "retryable_failed" : "permanently_failed";
      const nextRun = isRetryable ? new Date(Date.now() + calculateBackoff(job.attempts + 1)) : now;
      await db.update(automationQueue).set({
        status: nextStatus,
        scheduledAt: nextRun,
        lastError: message.slice(0, 4000),
        lockToken: null,
        lockedAt: null,
      }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));

      await recordAudit({
        ownerId,
        actorType: "system",
        action: "automation.failed",
        resourceType: "automation_job",
        resourceId: job.id,
        previousState: "running",
        nextState: nextStatus,
        metadata: { taskType: "execute_policy_decision", error: message },
      });

      return { status: nextStatus as "retryable_failed" | "permanently_failed", jobId: job.id };
    }
  }

  if (job.jobType === "scan_document") {
    const payload = (job.payload ?? {}) as { documentId?: string; candidateId?: string };
    if (!payload.documentId) {
      await db.update(automationQueue).set({ status: "permanently_failed", lastError: "Missing documentId in scan payload.", lockToken: null, lockedAt: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      return { status: "permanently_failed" as const, jobId: job.id };
    }
    try {
      const scanResult = await scanCandidateDocument(payload.documentId, ownerId);
      await db.update(automationQueue).set({ status: "completed", result: scanResult, completedAt: new Date(), lockToken: null, lockedAt: null, lastError: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      await recordAudit({ ownerId, actorType: "system", action: "automation.completed", resourceType: "automation_job", resourceId: job.id, previousState: "running", nextState: "completed", metadata: { taskType: "scan_document", scanStatus: scanResult.status, findings: scanResult.findings } });
      return { status: "completed" as const, jobId: job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Document scan failed.";
      const isRetryable = job.attempts + 1 < job.maxAttempts;
      const nextStatus = isRetryable ? "retryable_failed" : "permanently_failed";
      const nextRun = isRetryable ? new Date(Date.now() + calculateBackoff(job.attempts + 1)) : now;
      await db.update(automationQueue).set({ status: nextStatus, scheduledAt: nextRun, lastError: message.slice(0, 4000), lockToken: null, lockedAt: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      await recordAudit({ ownerId, actorType: "system", action: "automation.failed", resourceType: "automation_job", resourceId: job.id, previousState: "running", nextState: nextStatus, metadata: { taskType: "scan_document", error: message } });
      return { status: nextStatus as "retryable_failed" | "permanently_failed", jobId: job.id };
    }
  }

  if (job.jobType === "parse_cv" && (job.payload as Record<string, unknown>)?.documentId) {
    const documentId = String((job.payload as Record<string, unknown>).documentId);
    const doc = (await db.select().from(candidateDocuments).where(and(eq(candidateDocuments.id, documentId), eq(candidateDocuments.ownerId, ownerId))).limit(1))[0];
    if (doc && doc.scanState === "flagged") {
      await db.update(automationQueue).set({ status: "blocked", lastError: "CV parsing blocked: document was flagged by security scan.", lockToken: null, lockedAt: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
      await recordAudit({ ownerId, actorType: "system", action: "automation.blocked", resourceType: "automation_job", resourceId: job.id, previousState: "running", nextState: "blocked", metadata: { taskType: "parse_cv", reason: "document_flagged" } });
      return { status: "blocked" as const, jobId: job.id };
    }
  }

  if (!AI_JOB_TYPES.has(job.jobType as AiTaskType)) {
    await db.update(automationQueue).set({ status: "blocked", lastError: "Unsupported automation job type.", lockToken: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
    return { status: "blocked" as const, jobId: job.id };
  }
  const route = (await db.select().from(aiModelRoutes).where(and(eq(aiModelRoutes.ownerId, ownerId), eq(aiModelRoutes.taskType, job.jobType), eq(aiModelRoutes.isActive, true))).limit(1))[0];
  const usageId = createId("aiu_");
  try {
    const response = await runControlledAiTask({
      taskType: job.jobType as AiTaskType,
      input: (job.payload ?? {}) as Record<string, unknown>,
      primaryModel: route?.primaryModel ?? process.env.FREELANCEHR_BUILT_IN_MODEL ?? "manus-1.6-lite",
      fallbackModels: (route?.fallbackModels as string[] | null) ?? [],
      maxOutputTokens: route?.maxOutputTokens ?? 1200,
    });
    await db.insert(aiUsage).values({ id: usageId, ownerId, routeId: route?.id ?? null, queueJobId: job.id, taskType: job.jobType, requestedModel: route?.primaryModel ?? process.env.FREELANCEHR_BUILT_IN_MODEL ?? "manus-1.6-lite", selectedModel: response.selectedModel, status: "succeeded", latencyMs: response.latencyMs });
    await db.update(automationQueue).set({ status: "completed", result: response.result, completedAt: new Date(), lockToken: null, lockedAt: null, lastError: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
    await handleAiTaskResult(job, response.result, response.selectedModel, ownerId, db);
    await recordAudit({ ownerId, actorType: "ai", actorId: response.selectedModel, action: "automation.completed", resourceType: "automation_job", resourceId: job.id, previousState: "running", nextState: "completed", metadata: { taskType: job.jobType, latencyMs: response.latencyMs } });
    return { status: "completed" as const, jobId: job.id, selectedModel: response.selectedModel };
  } catch (error) {
    const isConfig = error instanceof OpenRouterConfigurationError;
    const isRetryable = error instanceof OpenRouterTransientError;
    const nextStatus = isConfig ? "blocked" : isRetryable && job.attempts + 1 < job.maxAttempts ? "retryable_failed" : "permanently_failed";
    const nextRun = isRetryable ? new Date(Date.now() + calculateBackoff(job.attempts + 1)) : now;
    const message = error instanceof Error ? error.message : "Unknown automation error.";
    await db.insert(aiUsage).values({ id: usageId, ownerId, routeId: route?.id ?? null, queueJobId: job.id, taskType: job.jobType, requestedModel: route?.primaryModel ?? process.env.FREELANCEHR_BUILT_IN_MODEL ?? "manus-1.6-lite", status: nextStatus, errorCode: error instanceof OpenRouterValidationError ? "invalid_output" : isConfig ? "configuration" : "provider" });
    await db.update(automationQueue).set({ status: nextStatus, scheduledAt: nextRun, lastError: message.slice(0, 4000), lockToken: null, lockedAt: null }).where(and(eq(automationQueue.id, job.id), eq(automationQueue.lockToken, lockToken)));
    await recordAudit({ ownerId, actorType: "system", action: "automation.failed", resourceType: "automation_job", resourceId: job.id, previousState: "running", nextState: nextStatus, metadata: { taskType: job.jobType, error: message } });
    return { status: nextStatus as "blocked" | "retryable_failed" | "permanently_failed", jobId: job.id };
  }
}

export type ProcessBatchResult = {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  results: Array<{
    status: string;
    jobId?: string;
    reason?: string;
    selectedModel?: string;
  }>;
};

export async function processDueAutomationBatch(ownerId?: number, limit = 5): Promise<ProcessBatchResult> {
  const boundedLimit = Math.min(Math.max(limit, 1), 25);
  const results: Array<{ status: string; jobId?: string; reason?: string; selectedModel?: string }> = [];
  const skippedOwnerIds = new Set<number>();

  for (let i = 0; i < boundedLimit; i++) {
    let targetOwnerId = ownerId;
    if (typeof targetOwnerId !== "number") {
      const db = await requireDb();
      const now = new Date();
      const conditions = [
        inArray(automationQueue.status, ["queued", "retryable_failed"]),
        lte(automationQueue.scheduledAt, now),
      ];
      if (skippedOwnerIds.size > 0) {
        conditions.push(notInArray(automationQueue.ownerId, Array.from(skippedOwnerIds)));
      }

      const candidate = (
        await db
          .select({ id: automationQueue.id, ownerId: automationQueue.ownerId })
          .from(automationQueue)
          .where(and(...conditions))
          .orderBy(asc(automationQueue.priority), asc(automationQueue.scheduledAt))
          .limit(1)
      )[0];
      if (!candidate) break;
      targetOwnerId = candidate.ownerId;
    }

    const outcome = await processOneQueuedJob(targetOwnerId);
    if (outcome.status === "empty") {
      if (typeof ownerId !== "number" && targetOwnerId !== undefined) {
        skippedOwnerIds.add(targetOwnerId);
        continue;
      }
      break;
    }
    results.push(outcome);
    if (outcome.status === "skipped") {
      if (typeof ownerId !== "number" && targetOwnerId !== undefined) {
        skippedOwnerIds.add(targetOwnerId);
        continue;
      }
      break;
    }
  }

  const completed = results.filter(r => r.status === "completed").length;
  const failed = results.filter(r => ["blocked", "retryable_failed", "permanently_failed"].includes(r.status)).length;
  const skipped = results.filter(r => r.status === "skipped").length;

  return {
    processed: results.length,
    completed,
    failed,
    skipped,
    results,
  };
}

