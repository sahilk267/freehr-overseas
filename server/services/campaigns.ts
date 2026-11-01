import { campaignInput } from "../validators/campaigns";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { candidates, companies, consents, contacts, conversations, emailIdentities, followUpPlans, outreachCampaignRecipients, outreachCampaigns, suppressionList, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { CAMPAIGN_SCENARIOS, renderCampaignText } from "../../shared/campaigns";
import type { FollowUpStep } from "../../shared/followups";
import { createId, ensureWorkspace, hashContactValue, requireDb } from "../db";
import { lockedSelect } from "./database";
import { enrollFollowUpInTransaction } from "./followups";
import { grantFollowUpSendingInTransaction } from "./followupControl";
import { appendWorkflowEvent, stopFollowUp, workflowHash } from "./workflowStore";
import { validateTimezone } from "./workflowTiming";

type Campaign = typeof outreachCampaigns.$inferSelect;
const activePlans = ["scheduled", "waiting", "approval_pending", "paused", "blocked"];
const terminalPlans = ["completed", "cancelled", "exhausted"];
const fail = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

async function campaignLock(tx: any, ownerId: number, id: string): Promise<Campaign> {
  await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
  const row = (await lockedSelect(tx.select().from(outreachCampaigns).where(and(eq(outreachCampaigns.ownerId, ownerId), eq(outreachCampaigns.id, id))).limit(1)))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign was not found." });
  return { ...row };
}

export async function createCampaign(ownerId: number, actorId: number, raw: z.input<typeof campaignInput>) {
  const input = campaignInput.parse(raw);
  validateTimezone(input.timezone);
  if (input.deadlineAt.getTime() <= Date.now() + input.steps[0].delayMinutes * 60000 || input.deadlineAt.getTime() > Date.now() + 30 * 86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Deadline must follow the first step and be within thirty days." });
  for (const step of input.steps) {
    if (!step.body.includes("{{opt_out}}") || /[\r\n]/.test(step.subject)) throw new TRPCError({ code: "BAD_REQUEST", message: "Every message needs {{opt_out}} and a single-line subject." });
    for (const template of [step.subject, step.body]) {
      try {
        const rendered = renderCampaignText(template, { name: "Recipient", company: "Company" });
        if (rendered.includes("{{") || rendered.includes("}}")) throw Error("Malformed variable");
      } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Use only {{name}}, {{company}} and {{opt_out}} template variables." }); }
    }
  }
  const definition = { ...input, recipientIds: [...new Set(input.recipientIds)].sort() };
  const requestHash = workflowHash(definition);
  const db = await requireDb();
  await ensureWorkspace(ownerId);
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    const existing = (await tx.select().from(outreachCampaigns).where(and(eq(outreachCampaigns.ownerId, ownerId), eq(outreachCampaigns.requestKey, input.requestKey))).limit(1))[0];
    if (existing) {
      if (existing.requestHash !== requestHash) throw new TRPCError({ code: "CONFLICT", message: "This request key already belongs to different campaign content." });
      return { id: existing.id as string, alreadyCreated: true };
    }
    const scenario = CAMPAIGN_SCENARIOS.find(s => s.id === input.scenarioId)!;
    const sender = (await tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, ownerId), eq(emailIdentities.id, input.senderIdentityId))).limit(1))[0];
    if (!sender || sender.purpose !== scenario.purpose) throw fail("Choose an owned sender for this campaign purpose.");
    const table = scenario.audience === "candidate" ? candidates : contacts;
    const people = await tx.select().from(table).where(and(eq(table.ownerId, ownerId), inArray(table.id, definition.recipientIds)));
    if (people.length !== definition.recipientIds.length) throw new TRPCError({ code: "NOT_FOUND", message: "An audience member is missing or belongs to another workspace." });
    const id = createId("cam_");
    const { recipientIds: _audience, ...settings } = input;
    await tx.insert(outreachCampaigns).values({ ...settings, id, ownerId, audienceType: scenario.audience, createdById: actorId, requestHash, status: "draft", revision: 1, launchHash: null, lastProcessedAt: null, lastError: null });
    for (const recipientId of definition.recipientIds) await tx.insert(outreachCampaignRecipients).values({ id: createId("cmr_"), ownerId, campaignId: id, recipientId, status: "pending", recipientHash: null, renderedSteps: null, planId: null, reason: null });
    await appendWorkflowEvent(tx, ownerId, "campaign.created", id, 1, { actorId, scenarioId: input.scenarioId, recipientCount: definition.recipientIds.length, requestHash });
    return { id, alreadyCreated: false };
  });
}

async function recipientSnapshot(tx: any, campaign: Campaign, recipientId: string) {
  const ownerId = campaign.ownerId;
  const table = campaign.audienceType === "candidate" ? candidates : contacts;
  const person = (await lockedSelect(tx.select().from(table).where(and(eq(table.ownerId, ownerId), eq(table.id, recipientId))).limit(1)))[0];
  const email = person?.email?.trim().toLowerCase() ?? "";
  let reason: string | null = null;
  if (!person || !z.string().email().safeParse(email).success) reason = "Current recipient email is unavailable.";
  else if (person.deletedAt || person.withdrawnAt || person.doNotContactAt || person.optedOutAt || ["deleted", "deletion_pending", "withdrawn", "do_not_contact"].includes(person.profileState)) reason = "Recipient is withdrawn, erased or opted out.";
  const permissionRows = campaign.audienceType === "candidate"
    ? await tx.select().from(consents).where(and(eq(consents.ownerId, ownerId), eq(consents.candidateId, recipientId), eq(consents.status, "granted"), eq(consents.consentType, "recruitment_communication")))
    : await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.aggregateId, recipientId), eq(workflowEvents.eventType, "communication.permission_recorded"))).orderBy(desc(workflowEvents.revision)).limit(1);
  const now = new Date();
  if (!reason && campaign.audienceType === "candidate" && !permissionRows.some((p: any) => !p.jobId && (!p.expiresAt || p.expiresAt > now))) reason = "Current unscoped recruitment communication permission is required.";
  if (!reason && campaign.audienceType === "contact" && (!["granted", "permitted", "consented"].includes(person.contactPermission) || (permissionRows[0]?.metadata?.expiresAt && new Date(permissionRows[0].metadata.expiresAt) <= now))) reason = "Documented contact permission is missing or expired.";
  const recipientHash = email ? hashContactValue(email) : "";
  if (!reason && (await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId, ownerId), eq(suppressionList.valueHash, recipientHash), eq(suppressionList.active, true))).limit(1)).length) reason = "Recipient is suppressed.";
  const conflicts = recipientHash ? await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.recipientHash, recipientHash), inArray(followUpPlans.status, activePlans))).limit(1) : [];
  if (!reason && conflicts.length) reason = "Another active or held sequence already owns this recipient; review it first.";
  const company = person?.companyId ? (await tx.select().from(companies).where(and(eq(companies.id, person.companyId), eq(companies.ownerId, ownerId))).limit(1))[0] : null;
  const name = campaign.audienceType === "candidate" ? person?.fullName ?? "" : person?.name ?? "";
  const steps = campaign.steps.map(step => ({ ...step, subject: renderCampaignText(step.subject, { name, company: company?.name ?? "" }), body: renderCampaignText(step.body, { name, company: company?.name ?? "" }) }));
  if (!reason && steps.some(step => step.subject.length > 255 || step.body.length > 12000 || /[\r\n]/.test(step.subject))) reason = "Rendered message exceeds limits or contains a multiline subject.";
  return { recipientId, name, email, recipientHash, steps, reason };
}

async function campaignPreview(tx: any, campaign: Campaign) {
  const sender = (await lockedSelect(tx.select().from(emailIdentities).where(and(eq(emailIdentities.ownerId, campaign.ownerId), eq(emailIdentities.id, campaign.senderIdentityId))).limit(1)))[0];
  const scenario = CAMPAIGN_SCENARIOS.find(s => s.id === campaign.scenarioId)!;
  const senderReady = sender?.status === "active" && sender?.purpose === scenario.purpose;
  const members = await tx.select().from(outreachCampaignRecipients).where(and(eq(outreachCampaignRecipients.ownerId, campaign.ownerId), eq(outreachCampaignRecipients.campaignId, campaign.id))).orderBy(asc(outreachCampaignRecipients.recipientId));
  const audience = [], seen = new Set<string>();
  for (const member of members) {
    const snapshot = await recipientSnapshot(tx, campaign, member.recipientId);
    if (!snapshot.reason && seen.has(snapshot.recipientHash)) snapshot.reason = "Duplicate recipient address within this audience.";
    if (!snapshot.reason) seen.add(snapshot.recipientHash);
    audience.push(snapshot);
  }
  const previewHash = workflowHash([campaign.id, campaign.revision, campaign.steps, campaign.executionMode, campaign.timezone, campaign.businessDaysOnly, campaign.deadlineAt, sender?.id, sender?.email, sender?.purpose, sender?.status, audience]);
  return { previewHash, senderReady: Boolean(senderReady), audience, eligibleCount: audience.filter(a => !a.reason).length };
}

export async function previewCampaign(ownerId: number, id: string) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => campaignPreview(tx, await campaignLock(tx, ownerId, id)));
}

export async function launchCampaign(ownerId: number, actorId: number, input: { id: string; expectedRevision: number; previewHash: string; authorizeSending: boolean }) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const campaign = await campaignLock(tx, ownerId, input.id);
    if (campaign.status === "active" && campaign.launchHash === input.previewHash && campaign.revision === input.expectedRevision + 1) return { id: campaign.id, alreadyActive: true };
    if (campaign.status !== "draft" || campaign.revision !== input.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Campaign changed or has already launched. Reload it." });
    const preview = await campaignPreview(tx, campaign);
    if (preview.previewHash !== input.previewHash) throw new TRPCError({ code: "CONFLICT", message: "Audience, content or permission changed. Review a fresh preview." });
    if (!preview.senderReady || !preview.eligibleCount) throw fail("A verified purpose-specific sender and at least one permitted recipient are required.");
    if (campaign.deadlineAt <= new Date()) throw fail("Campaign deadline has expired.");
    if (campaign.executionMode === "delegated" && !input.authorizeSending) throw fail("Explicitly authorize the exact previewed messages and bounded audience before automatic sending.");
    for (const member of preview.audience) await tx.update(outreachCampaignRecipients).set({ recipientHash: member.recipientHash || null, renderedSteps: member.steps, status: member.reason ? "skipped" : "pending", reason: member.reason }).where(and(eq(outreachCampaignRecipients.campaignId, campaign.id), eq(outreachCampaignRecipients.recipientId, member.recipientId)));
    await tx.update(outreachCampaigns).set({ status: "active", revision: campaign.revision + 1, launchHash: input.previewHash }).where(eq(outreachCampaigns.id, campaign.id));
    await appendWorkflowEvent(tx, ownerId, "campaign.launched", campaign.id, campaign.revision + 1, { actorId, previewHash: input.previewHash, executionMode: campaign.executionMode, permittedRecipients: preview.eligibleCount, maxMessagesPerRecipient: campaign.steps.length, expiresAt: campaign.deadlineAt.toISOString() });
    return { id: campaign.id, alreadyActive: false };
  });
}

export async function controlCampaign(ownerId: number, actorId: number, input: { id: string; expectedRevision: number; action: "pause" | "resume_review" | "cancel" }) {
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const campaign = await campaignLock(tx, ownerId, input.id);
    if (campaign.revision !== input.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Campaign changed; reload before controlling it." });
    if (["cancelled", "completed"].includes(campaign.status)) throw fail("Campaign has ended.");
    if (input.action === "pause" && campaign.status !== "active") throw fail("Only an active reviewed campaign can pause.");
    if (input.action === "resume_review" && campaign.status !== "paused") throw fail("Only a paused campaign can resume.");
    if (input.action === "resume_review" && (!campaign.launchHash || campaign.deadlineAt <= new Date())) throw fail("Review a new campaign; this activation is missing or expired.");
    const status = input.action === "pause" ? "paused" : input.action === "cancel" ? "cancelled" : "active";
    const members = await tx.select().from(outreachCampaignRecipients).where(and(eq(outreachCampaignRecipients.ownerId, ownerId), eq(outreachCampaignRecipients.campaignId, campaign.id)));
    if (input.action !== "resume_review") for (const member of members) {
      if (member.planId) {
        const plan = (await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, member.planId))).limit(1))[0];
        if (plan) await stopFollowUp(tx, plan, input.action === "pause" ? "paused" : "cancelled", `Campaign ${input.action} requested by owner`);
      }
      if (!member.planId && input.action === "cancel") await tx.update(outreachCampaignRecipients).set({ status: "cancelled", reason: "Campaign cancelled by owner" }).where(eq(outreachCampaignRecipients.id, member.id));
    }
    await tx.update(outreachCampaigns).set({ status, executionMode: "review", revision: campaign.revision + 1 }).where(eq(outreachCampaigns.id, campaign.id));
    await appendWorkflowEvent(tx, ownerId, `campaign.${status}`, campaign.id, campaign.revision + 1, { actorId, executionMode: "review", existingPausedSequencesRequireReview: input.action === "resume_review" });
    return { status };
  });
}

async function evaluateCampaign(ownerId: number, campaignId: string, limit: number) {
  const db = await requireDb();
  // One workspace lock serializes enrollment with manual plans, pause and consent withdrawal.
  return db.transaction(async (tx: any) => {
    const campaign = await campaignLock(tx, ownerId, campaignId);
    if (campaign.status !== "active") return { enrolled: 0, skipped: 0, considered: 0 };
    const workspace = (await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
    if (workspace?.emergencyStop) {
      await tx.update(outreachCampaigns).set({ lastProcessedAt: new Date() }).where(eq(outreachCampaigns.id, campaign.id));
      return { enrolled: 0, skipped: 0, considered: 0 };
    }
    const members: Array<typeof outreachCampaignRecipients.$inferSelect> = await tx.select().from(outreachCampaignRecipients).where(and(eq(outreachCampaignRecipients.ownerId, ownerId), eq(outreachCampaignRecipients.campaignId, campaign.id))).orderBy(asc(outreachCampaignRecipients.recipientId));
    let enrolled = 0, skipped = 0, processed = 0;
    for (const member of members) {
      if (member.planId) {
        const plan = (await tx.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, member.planId))).limit(1))[0];
        if (plan) await tx.update(outreachCampaignRecipients).set({ status: plan.status, reason: plan.reason }).where(eq(outreachCampaignRecipients.id, member.id));
        continue;
      }
      if (member.status !== "pending" || processed >= limit) continue;
      processed++;
      if (campaign.deadlineAt.getTime() <= Date.now() + campaign.steps[0].delayMinutes * 60_000) {
        await tx.update(outreachCampaignRecipients).set({ status: "cancelled", reason: "Campaign expired before enrollment" }).where(eq(outreachCampaignRecipients.id, member.id)); skipped++; continue;
      }
      const snapshot = await recipientSnapshot(tx, campaign, member.recipientId);
      if (snapshot.reason || snapshot.recipientHash !== member.recipientHash) {
        await tx.update(outreachCampaignRecipients).set({ status: "skipped", reason: snapshot.reason ?? "Recipient address changed after review" }).where(eq(outreachCampaignRecipients.id, member.id)); skipped++; continue;
      }
      const personColumn = campaign.audienceType === "candidate" ? conversations.candidateId : conversations.contactId;
      const threads = await tx.select().from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(personColumn, member.recipientId))).orderBy(desc(conversations.createdAt)).limit(100);
      let thread = threads.find((t: typeof conversations.$inferSelect) => !t.jobId && !["closed", "archived", "opted_out"].includes(t.status));
      if (!thread) {
        const table = campaign.audienceType === "candidate" ? candidates : contacts;
        const person = (await tx.select().from(table).where(and(eq(table.ownerId, ownerId), eq(table.id, member.recipientId))).limit(1))[0];
        const id = createId("cnv_");
        await tx.insert(conversations).values({ id, ownerId, candidateId: campaign.audienceType === "candidate" ? member.recipientId : null, contactId: campaign.audienceType === "contact" ? member.recipientId : null, companyId: person.companyId ?? null, channel: "email", status: "active" });
        thread = { id };
      }
      const plan = await enrollFollowUpInTransaction(tx, ownerId, { scenarioId: campaign.scenarioId, objective: campaign.name, conversationId: thread.id, senderIdentityId: campaign.senderIdentityId, timezone: campaign.timezone, businessDaysOnly: campaign.businessDaysOnly, deadlineAt: campaign.deadlineAt, steps: member.renderedSteps as FollowUpStep[], responseWindowMinutes: 3 * 1440 }, campaign.createdById);
      if (plan.alreadyEnrolled) {
        await tx.update(outreachCampaignRecipients).set({ status: "skipped", reason: "Existing historical sequence owns this conversation/scenario; review it instead of restarting it." }).where(eq(outreachCampaignRecipients.id, member.id)); skipped++; continue;
      }
      if (campaign.executionMode === "delegated") await grantFollowUpSendingInTransaction(tx, ownerId, campaign.createdById, plan.id, campaign.deadlineAt, campaign.steps.length, 1);
      await tx.update(outreachCampaignRecipients).set({ planId: plan.id, status: "scheduled", reason: null }).where(eq(outreachCampaignRecipients.id, member.id));
      await appendWorkflowEvent(tx, ownerId, "campaign.recipient_enrolled", campaign.id, campaign.revision, { recipientId: member.recipientId, planId: plan.id }, member.id);
      enrolled++;
    }
    const current = await tx.select().from(outreachCampaignRecipients).where(and(eq(outreachCampaignRecipients.ownerId, ownerId), eq(outreachCampaignRecipients.campaignId, campaign.id)));
    const ended = current.every((m: typeof outreachCampaignRecipients.$inferSelect) => ["skipped", "cancelled", ...terminalPlans].includes(m.status));
    await tx.update(outreachCampaigns).set({ lastProcessedAt: new Date(), lastError: null, ...(ended ? { status: "completed" } : {}) }).where(eq(outreachCampaigns.id, campaign.id));
    return { enrolled, skipped, considered: processed };
  });
}

export async function processDueCampaigns(ownerId?: number, limit = 25) {
  const db = await requireDb();
  const rows: Campaign[] = await db.select().from(outreachCampaigns).where(and(eq(outreachCampaigns.status, "active"), or(isNull(outreachCampaigns.lastProcessedAt), lte(outreachCampaigns.lastProcessedAt, new Date(Date.now() - 60_000))), ...(ownerId !== undefined ? [eq(outreachCampaigns.ownerId, ownerId)] : []))).orderBy(asc(outreachCampaigns.lastProcessedAt), asc(outreachCampaigns.id)).limit(Math.max(1, Math.min(25, limit)));
  let enrolled = 0, skipped = 0;
  let considered = 0, evaluated = 0;
  const failures: Array<{ campaignId: string; reason: string }> = [];
  for (const campaign of rows) {
    if (considered >= limit) break;
    evaluated++;
    try { const result = await evaluateCampaign(campaign.ownerId, campaign.id, limit - considered); enrolled += result.enrolled; skipped += result.skipped; considered += result.considered; }
    catch (error) {
      const reason = error instanceof TRPCError ? error.message : "Campaign processing failed; inspect server diagnostics before retrying.";
      failures.push({ campaignId: campaign.id, reason });
      // Rotate failed sources as well so one unavailable mailbox cannot starve the scan.
      await db.update(outreachCampaigns).set({ lastProcessedAt: new Date(), lastError: reason.slice(0, 500) }).where(and(eq(outreachCampaigns.id, campaign.id), eq(outreachCampaigns.ownerId, campaign.ownerId)));
    }
  }
  return { evaluated, enrolled, skipped, failures };
}
