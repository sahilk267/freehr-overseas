import { invoiceCollectionFacts, ACTIVE_COLLECTION_STATES } from "./collectionFacts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { approvals, automationGrants, candidates, consents, contacts, conversations, emailDispatches, emailIdentities, followUpPlans, interviews, invoices, jobs, messages, payments, suppressionList, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { FOLLOW_UP_SCENARIOS } from "../../shared/followups";
import { createId, ensureWorkspace, hashContactValue, requireDb } from "../db";
import { lockedSelect } from "./database";
import { emailContentHash } from "./emailAuthorization";
import { appendWorkflowEvent, followUpEnrollmentKey, recordFollowUpDefinition, grantScopeHash, scheduleFollowUp, stopFollowUp, workflowHash, type FollowUpPlan } from "./workflowStore";
import { validateTimezone } from "./workflowTiming";

const scenarioIds = FOLLOW_UP_SCENARIOS.map(scenario => scenario[0]) as [string, ...string[]];
export const followUpInput = z.object({
  scenarioId: z.enum(scenarioIds), objective: z.string().trim().min(3).max(500),
  conversationId: z.string().min(4).optional(), candidateId: z.string().min(4).optional(), contactId: z.string().min(4).optional(),
  senderIdentityId: z.string().min(4), resourceType: z.enum(["conversation", "interview", "invoice"]).default("conversation"), resourceId: z.string().min(4).optional(),
  timezone: z.string().min(2).max(64).default("Asia/Kolkata"), businessDaysOnly: z.boolean().default(false),
  startsAt: z.date().optional(), deadlineAt: z.date(), responseWindowMinutes: z.number().int().min(1).max(43200).default(1440),
  steps: z.array(z.object({ delayMinutes: z.number().int().min(0).max(43200), subject: z.string().trim().min(1).max(255), body: z.string().trim().min(8).max(12000) })).min(1).max(6),
});

export async function inboundCursor(tx: any, ownerId: number, conversationId: string) {
  return (await lockedSelect(tx.select().from(messages).where(and(eq(messages.ownerId, ownerId), eq(messages.conversationId, conversationId), eq(messages.direction, "inbound"))).orderBy(desc(messages.createdAt)).limit(100))).map((message: typeof messages.$inferSelect) => message.id);
}

export async function followUpEligibility(tx: any, plan: FollowUpPlan, now = new Date()): Promise<{ state: "eligible" | "cancelled" | "completed" | "paused" | "blocked"; reason?: string; fingerprint?: string }> {
  if (plan.deadlineAt <= now) return { state: "cancelled", reason: "Follow-up deadline expired." };
  const sender = (await lockedSelect(tx.select().from(emailIdentities).where(and(eq(emailIdentities.id, plan.senderIdentityId), eq(emailIdentities.ownerId, plan.ownerId))).limit(1)))[0];
  if (!sender || sender.status !== "active" || sender.purpose !== FOLLOW_UP_SCENARIOS.find(item => item[0] === plan.scenarioId)?.[2]) return { state: "blocked", reason: "Sender identity or purpose changed." };
  const conversation = (await lockedSelect(tx.select().from(conversations).where(and(eq(conversations.id, plan.conversationId), eq(conversations.ownerId, plan.ownerId))).limit(1)))[0];
  if (!conversation || ["closed", "archived", "opted_out"].includes(conversation.status)) return { state: "cancelled", reason: "Conversation is closed or opted out." };
  const newerReply = (await inboundCursor(tx, plan.ownerId, plan.conversationId)).some((id: string) => !(plan.replyCursor ?? []).includes(id));
  if (newerReply) return { state: "paused", reason: "Recipient replied; review the conversation before resuming." };
  if ((await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId, plan.ownerId), eq(suppressionList.channel, "email"), eq(suppressionList.valueHash, plan.recipientHash), eq(suppressionList.active, true))).limit(1)).length) return { state: "cancelled", reason: "Recipient is suppressed." };
  if (conversation.candidateId) {
    const candidate = (await lockedSelect(tx.select().from(candidates).where(and(eq(candidates.id, conversation.candidateId), eq(candidates.ownerId, plan.ownerId))).limit(1)))[0];
    if (!candidate || candidate.deletedAt || candidate.withdrawnAt || candidate.doNotContactAt || ["deleted", "deletion_pending", "withdrawn", "do_not_contact"].includes(candidate.profileState) || candidate.email?.trim().toLowerCase() !== plan.recipient) return { state: "cancelled", reason: "Candidate is withdrawn, unavailable for contact or has changed address." };
    const grants = await lockedSelect(tx.select().from(consents).where(and(eq(consents.ownerId, plan.ownerId), eq(consents.candidateId, candidate.id), eq(consents.status, "granted"))));
    const allowedTypes = plan.scenarioId === "FU18" || plan.scenarioId === "FU17" || plan.scenarioId === "FU19" ? ["interview_processing", "recruitment_communication"] : ["recruitment_communication"];
    if (!grants.some((consent: typeof consents.$inferSelect) => allowedTypes.includes(consent.consentType) && (!consent.expiresAt || consent.expiresAt > now) && (!consent.jobId || consent.jobId === conversation.jobId))) return { state: "blocked", reason: "Current purpose-appropriate communication permission is required." };
  } else if (conversation.contactId) {
    const contact = (await lockedSelect(tx.select().from(contacts).where(and(eq(contacts.id, conversation.contactId), eq(contacts.ownerId, plan.ownerId))).limit(1)))[0];
    if (!contact || contact.companyId !== conversation.companyId || contact.optedOutAt || contact.email?.trim().toLowerCase() !== plan.recipient) return { state: "cancelled", reason: "Contact is opted out or has changed address." };
    const permissions = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, plan.ownerId), eq(workflowEvents.aggregateId, contact.id), eq(workflowEvents.eventType, "communication.permission_recorded"))).orderBy(desc(workflowEvents.revision)).limit(1);
    if (permissions[0]?.metadata?.expiresAt && new Date(permissions[0].metadata.expiresAt) <= now) return { state: "blocked", reason: "Documented contact permission expired." };
    if (!["granted", "permitted", "consented"].includes(contact.contactPermission)) return { state: "blocked", reason: "Documented contact permission is required." };
  } else return { state: "blocked", reason: "Conversation must be linked to an owned candidate or business contact." };
  if (conversation.jobId) {
    const job = (await lockedSelect(tx.select().from(jobs).where(and(eq(jobs.id, conversation.jobId), eq(jobs.ownerId, plan.ownerId))).limit(1)))[0];
    if (!job || ["cancelled", "archived", "filled", "paused"].includes(job.pipelineState)) return { state: "cancelled", reason: "Related job is no longer active." };
  }
  let fingerprint: string;
  if (plan.resourceType === "interview") {
    const interview = (await lockedSelect(tx.select().from(interviews).where(and(eq(interviews.id, plan.resourceId), eq(interviews.ownerId, plan.ownerId))).limit(1)))[0];
    if (!interview || interview.candidateId !== conversation.candidateId || interview.jobId !== conversation.jobId) return { state: "cancelled", reason: "Interview relationship is invalid." };
    if (!interview.scheduledAt || interview.scheduledAt <= now || ["cancelled", "closed", "completed", "feedback_pending", "feedback_received", "no_show", "reminder_sent"].includes(interview.status)) return { state: "completed", reason: "Interview reminder is no longer applicable." };
    if (interview.status !== "confirmed" || interview.calendarStatus !== "confirmed") return { state: "paused", reason: "Interview is not confirmed." };
    fingerprint = workflowHash(["interview", interview.id, interview.scheduledAt.toISOString(), interview.calendarSequence ?? 0]);
  } else if (plan.resourceType === "invoice") {
    const invoice = (await lockedSelect(tx.select().from(invoices).where(and(eq(invoices.id, plan.resourceId), eq(invoices.ownerId, plan.ownerId))).limit(1)))[0];
    if (!invoice || !conversation.contactId || invoice.companyId !== conversation.companyId) return { state: "cancelled", reason: "Invoice contact relationship is invalid." };
    if (["paid", "closed", "credited", "written_off", "cancelled"].includes(invoice.status)) return { state: "completed", reason: "Invoice no longer has a collectible obligation." };
    if (!["issued", "delivered", "payment_pending", "partially_paid", "overdue"].includes(invoice.status)) return { state: "paused", reason: "Invoice is not eligible for collection." };
    const finance = await invoiceCollectionFacts(tx, plan.ownerId, invoice, now);
    if (finance.reason) return { state: "paused", reason: finance.reason };
    if (finance.rules && plan.steps.length > finance.rules.maxNudges) return { state: "blocked", reason: "Sequence exceeds the invoice collection message limit." };
    if (finance.rules && (finance.rules.contactId !== conversation.contactId || finance.rules.senderIdentityId !== plan.senderIdentityId)) return { state: "cancelled", reason: "Collection recipient or sender configuration changed." };
    if (plan.scenarioId === "FU27" && finance.promiseState !== "missed") return { state: "paused", reason: "There is no missed payment promise to follow up." };
    fingerprint = finance.fingerprint;
  } else {
    if (plan.resourceId !== conversation.id) return { state: "cancelled", reason: "Conversation resource mismatch." };
    fingerprint = workflowHash(["conversation", conversation.id, plan.recipientHash, conversation.jobId ?? null]);
  }
  fingerprint = workflowHash([fingerprint, sender.id, sender.email, sender.purpose]);
  if (plan.resourceFingerprint && plan.resourceFingerprint !== fingerprint) return { state: "cancelled", reason: "Resource changed; review and replan using current evidence." };
  return { state: "eligible", fingerprint };
}

export async function enrollFollowUp(ownerId: number, raw: z.input<typeof followUpInput>, actorId?: number) {
  const db = await requireDb();
  await ensureWorkspace(ownerId);
  return db.transaction((tx: any) => enrollFollowUpInTransaction(tx, ownerId, raw, actorId));
}

export async function enrollFollowUpInTransaction(tx: any, ownerId: number, raw: z.input<typeof followUpInput>, actorId?: number) {
  const input = followUpInput.parse(raw);
  if ((input.scenarioId === "FU18" && input.resourceType !== "interview") || (input.resourceType === "interview" && input.scenarioId !== "FU18") || (["FU26", "FU27"].includes(input.scenarioId) && input.resourceType !== "invoice") || (input.resourceType === "invoice" && !["FU26", "FU27"].includes(input.scenarioId))) throw new TRPCError({ code: "BAD_REQUEST", message: "This scenario requires its interview or invoice resource." });
  validateTimezone(input.timezone);
  const startsAt = new Date((input.startsAt ?? new Date()).getTime() + input.steps[0].delayMinutes * 60_000);
  if (input.deadlineAt <= startsAt || input.deadlineAt.getTime() > Date.now() + 366 * 86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Deadline must follow the start and be within one year." });
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const identity = (await tx.select().from(emailIdentities).where(and(eq(emailIdentities.id, input.senderIdentityId), eq(emailIdentities.ownerId, ownerId))).limit(1))[0];
    const scenario = FOLLOW_UP_SCENARIOS.find(value => value[0] === input.scenarioId)!;
    if (!identity || identity.status !== "active" || identity.purpose !== scenario[2]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Choose an active sender for this follow-up purpose." });
    let conversation: typeof conversations.$inferSelect | undefined;
    if (input.conversationId) conversation = (await tx.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerId, ownerId))).limit(1))[0];
    else {
      const meeting = input.resourceType === "interview" ? (await tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, input.resourceId ?? ""))).limit(1))[0] : null;
      if (input.resourceType === "interview" && (!meeting || meeting.candidateId !== input.candidateId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the candidate linked to this owned interview." });
      const table = input.candidateId ? candidates : contacts;
      const personId = input.candidateId ?? input.contactId;
      if (!personId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a candidate or business contact." });
      const person = (await tx.select().from(table).where(and(eq(table.id, personId), eq(table.ownerId, ownerId))).limit(1))[0];
      if (!person?.email) throw new TRPCError({ code: "NOT_FOUND", message: "Owned recipient with an email address was not found." });
      conversation = (await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), input.candidateId ? eq(conversations.candidateId, personId) : eq(conversations.contactId, personId), ...(meeting ? [eq(conversations.jobId, meeting.jobId)] : []))).limit(1))[0];
      if (!conversation) {
        const conversationId = createId("cnv_");
        await tx.insert(conversations).values({ id: conversationId, ownerId, candidateId: input.candidateId ?? null, contactId: input.contactId ?? null, companyId: meeting?.companyId ?? (input.contactId ? person.companyId : null), jobId: meeting?.jobId ?? null, channel: "email", status: "active" });
        conversation = (await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1))[0];
      }
    }
    if (!conversation) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation was not found." });
    const table = conversation.candidateId ? candidates : contacts;
    const person = (await tx.select().from(table).where(and(eq(table.ownerId, ownerId), eq(table.id, conversation.candidateId ?? conversation.contactId ?? ""))).limit(1))[0];
    if (!person?.email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A current recipient address is required." });
    const recipient = z.string().email().parse(person.email.trim().toLowerCase());
    const recipientHash = hashContactValue(recipient);
    const resourceId = input.resourceId ?? conversation.id;
    const key = workflowHash([ownerId, input.scenarioId, input.resourceType, resourceId, recipientHash]);
    const id = createId("fup_");
    const plan = { id, ownerId, conversationId: conversation.id, candidateId: conversation.candidateId ?? null, senderIdentityId: input.senderIdentityId, recipient, recipientHash, scenarioId: input.scenarioId, resourceType: input.resourceType, resourceId, resourceFingerprint: "", replyCursor: await inboundCursor(tx, ownerId, conversation.id), enrollmentKey: key, objective: input.objective, status: "scheduled", revision: 1, stepIndex: 0, steps: input.steps, timezone: input.timezone, businessDaysOnly: input.businessDaysOnly, responseWindowMinutes: input.responseWindowMinutes, executionMode: "review", nextActionAt: startsAt, deadlineAt: input.deadlineAt, reason: null, createdAt: new Date(), updatedAt: new Date() } as FollowUpPlan;
    const eligibility = await followUpEligibility(tx, plan);
    if (eligibility.state !== "eligible") throw new TRPCError({ code: "PRECONDITION_FAILED", message: eligibility.reason });
    plan.resourceFingerprint = eligibility.fingerprint!;
    plan.enrollmentKey = followUpEnrollmentKey(plan);
    const existing = (await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.enrollmentKey, plan.enrollmentKey))).limit(1))[0];
    const recordSource = async (planId: string) => {
      if (plan.resourceType === "interview") {
        const meeting = (await tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, plan.resourceId))).limit(1))[0];
        await appendWorkflowEvent(tx, ownerId, "interview.followup_enrolled", plan.resourceId, meeting.calendarSequence ?? 0, { planId });
      }
    };
    if (existing) { await recordSource(existing.id); return { id: existing.id, alreadyEnrolled: true, status: existing.status }; }
    if (plan.resourceType === "invoice") {
      const active = await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.resourceType, "invoice"), eq(followUpPlans.resourceId, plan.resourceId), inArray(followUpPlans.status, ACTIVE_COLLECTION_STATES))).limit(1));
      if (active.length) throw new TRPCError({ code: "CONFLICT", message: "Another active collection sequence already owns this invoice. Review or replan it first." });
    }
    await tx.insert(followUpPlans).values(plan);
    await recordFollowUpDefinition(tx, plan, actorId, "Initial enrollment in owner-review mode");
    await recordSource(plan.id);
    await scheduleFollowUp(tx, plan, startsAt);
    await appendWorkflowEvent(tx, ownerId, "followup.enrolled", id, 1, { scenarioId: plan.scenarioId, executionMode: "review" });
    return { id, alreadyEnrolled: false, status: "scheduled" };
}

export async function prepareFollowUp(ownerId: number, payload: { planId?: string; revision?: number; stepIndex?: number }, now = new Date()) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const plan = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.id, payload.planId ?? ""), eq(followUpPlans.ownerId, ownerId))).limit(1)))[0] as FollowUpPlan;
    if (!plan || plan.revision !== payload.revision || plan.stepIndex !== payload.stepIndex || !["scheduled", "waiting"].includes(plan.status)) return { status: "cancelled", reason: "Superseded follow-up task." };
    const eligibility = await followUpEligibility(tx, plan, now);
    if (eligibility.state !== "eligible") { await stopFollowUp(tx, plan, eligibility.state, eligibility.reason!); return { status: eligibility.state, reason: eligibility.reason }; }
    const step = plan.steps[plan.stepIndex];
    if (!step) { await stopFollowUp(tx, plan, "exhausted", "Sequence ended without a recorded response."); return { status: "exhausted" }; }
    const identity = (await tx.select().from(emailIdentities).where(and(eq(emailIdentities.id, plan.senderIdentityId), eq(emailIdentities.ownerId, ownerId))).limit(1))[0];
    if (!identity || identity.status !== "active") { await stopFollowUp(tx, plan, "blocked", "Sender is inactive."); return { status: "blocked" }; }
    let grant: typeof automationGrants.$inferSelect | undefined;
    if (plan.executionMode === "delegated") {
      grant = (await tx.select().from(automationGrants).where(and(eq(automationGrants.ownerId, ownerId), eq(automationGrants.planId, plan.id), eq(automationGrants.active, true))).limit(1))[0];
      if (!grant || grant.expiresAt <= now || grant.planRevision !== plan.revision || grant.scopeHash !== grantScopeHash(plan)) { await stopFollowUp(tx, plan, "blocked", "Automatic-sending permission expired or changed."); return { status: "blocked" }; }
    }
    const messageId = createId("msg_"); const approvalId = createId("apr_"); const dispatchId = createId("dsp_");
    const key = `followup:${plan.id}:${plan.revision}:${plan.stepIndex}`;
    await tx.insert(messages).values({ id: messageId, ownerId, conversationId: plan.conversationId, direction: "outbound", status: "approval_pending", deliveredAt: null, subject: step.subject, body: step.body, idempotencyKey: key, aiGenerated: false });
    await tx.insert(approvals).values({ id: approvalId, ownerId, requestedBy: "system", actionedAt: null, actionType: "email_send", resourceType: "message", resourceId: messageId, status: grant ? "approved" : "pending", decisionSource: grant ? "policy" : "manual", decidedById: grant ? ownerId : null, decidedAt: grant ? now : null, reason: grant ? "Bounded owner-delegated follow-up" : "Follow-up requires owner review", payload: { senderIdentityId: identity.id, senderAddress: identity.email, senderPurpose: identity.purpose, recipient: plan.recipient, contentHash: emailContentHash({ senderIdentityId: identity.id, recipient: plan.recipient, subject: step.subject, body: step.body }), followUpPlanId: plan.id, followUpRevision: plan.revision, grantId: grant?.id ?? null } });
    await tx.insert(emailDispatches).values({ id: dispatchId, ownerId, messageId, approvalId, planId: plan.id, planRevision: plan.revision, stepIndex: plan.stepIndex, grantId: grant?.id ?? null, recipientHash: plan.recipientHash, status: "queued", scheduledAt: now });
    await tx.update(followUpPlans).set({ status: "approval_pending", nextActionAt: null }).where(eq(followUpPlans.id, plan.id));
    await appendWorkflowEvent(tx, ownerId, "followup.prepared", plan.id, plan.revision, { messageId, approvalId, dispatchId, delegated: Boolean(grant) }, String(plan.stepIndex));
    // Both modes use the same durable outbox. Pending approval is checked by its consumer.
    if (grant) { await enqueueEmailDispatch(tx, ownerId, dispatchId, now); await tx.update(followUpPlans).set({ nextActionAt: now }).where(eq(followUpPlans.id, plan.id)); }
    return { status: "approval_pending", messageId, approvalId, dispatchId };
  });
}

export async function enqueueEmailDispatch(tx: any, ownerId: number, dispatchId: string, at: Date) {
  const { automationQueue } = await import("../../drizzle/schema");
  const key = `email_dispatch:${dispatchId}`;
  const existing = (await tx.select().from(automationQueue).where(eq(automationQueue.idempotencyKey, key)).limit(1))[0];
  if (!existing) await tx.insert(automationQueue).values({ id: createId("que_"), ownerId, jobType: "deliver_email", payload: { dispatchId }, status: "queued", priority: 10, scheduledAt: at, attempts: 0, maxAttempts: 3, idempotencyKey: key });
  else if (existing.status !== "running") await tx.update(automationQueue).set({ status: "queued", scheduledAt: at, lockToken: null, lockedAt: null }).where(eq(automationQueue.id, existing.id));
}

export async function advanceFollowUp(tx: any, dispatch: typeof emailDispatches.$inferSelect, now: Date) {
  if (!dispatch.planId) return;
  const plan = (await lockedSelect(tx.select().from(followUpPlans).where(and(eq(followUpPlans.id, dispatch.planId), eq(followUpPlans.ownerId, dispatch.ownerId))).limit(1)))[0] as FollowUpPlan;
  if (plan && plan.revision > dispatch.planRevision && plan.stepIndex === dispatch.stepIndex && ["paused", "blocked", "cancelled", "completed"].includes(plan.status)) {
    // A pause cannot undo a request already claimed by the provider. Preserve its
    // accepted step so a later explicit resume never sends that step again.
    await tx.update(followUpPlans).set({ stepIndex: plan.stepIndex + 1 }).where(eq(followUpPlans.id, plan.id));
    await appendWorkflowEvent(tx, plan.ownerId, "followup.late_acceptance", plan.id, plan.revision, { messageId: dispatch.messageId, stepIndex: dispatch.stepIndex }, dispatch.id);
    return;
  }
  if (!plan || plan.revision !== dispatch.planRevision || plan.stepIndex !== dispatch.stepIndex || plan.status !== "approval_pending") return;
  const nextStep = plan.stepIndex + 1;
  const nextAt = new Date(now.getTime() + (plan.steps[nextStep]?.delayMinutes ?? plan.responseWindowMinutes) * 60_000);
  const next = { ...plan, stepIndex: nextStep, status: "waiting" };
  await tx.update(followUpPlans).set({ stepIndex: nextStep, status: "waiting", reason: null }).where(eq(followUpPlans.id, plan.id));
  await scheduleFollowUp(tx, next, nextAt);
  await appendWorkflowEvent(tx, plan.ownerId, "followup.message_accepted", plan.id, plan.revision, { messageId: dispatch.messageId, stepIndex: dispatch.stepIndex }, String(dispatch.stepIndex));
  if (plan.resourceType === "interview") await tx.update(interviews).set({ status: "reminder_sent", reminderSentAt: now }).where(and(eq(interviews.id, plan.resourceId), eq(interviews.ownerId, plan.ownerId), eq(interviews.status, "confirmed")));
}

export async function stopRelatedFollowUps(tx: any, ownerId: number, context: { candidateId?: string; conversationId?: string; recipientHash?: string; resourceType?: string; resourceId?: string }, reason: string, state: "paused" | "cancelled" | "completed" = "cancelled") {
  const conditions = [eq(followUpPlans.ownerId, ownerId), inArray(followUpPlans.status, ["scheduled", "waiting", "approval_pending", "paused", "blocked"])];
  if (context.candidateId) conditions.push(eq(followUpPlans.candidateId, context.candidateId));
  else if (context.conversationId) conditions.push(eq(followUpPlans.conversationId, context.conversationId));
  else if (context.recipientHash) conditions.push(eq(followUpPlans.recipientHash, context.recipientHash));
  else if (context.resourceType && context.resourceId) conditions.push(eq(followUpPlans.resourceType, context.resourceType), eq(followUpPlans.resourceId, context.resourceId));
  else throw new Error("A bounded follow-up cancellation context is required.");
  const plans = await lockedSelect(tx.select().from(followUpPlans).where(and(...conditions)).limit(1000));
  for (const plan of plans) await stopFollowUp(tx, plan, state, reason);
  return plans.length;
}
