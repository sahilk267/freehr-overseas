import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import {
  approvals,
  automationQueue,
  candidates,
  candidateDocuments,
  companies,
  consents,
  contacts,
  feedback,
  feeProposals,
  interviews,
  invoices,
  jobs,
  matches,
  placements,
  rightsRequests,
  screenings,
  shortlists,
  suppressionList,
  workspaceSettings,
} from "../../drizzle/schema";
import { createId, ensureWorkspace, hashContactValue, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { createHeartbeatJob } from "../_core/heartbeat";
import { extractDocumentText } from "../services/documentText";
import { getPrivateDocumentUrl, putPrivateDocument } from "../services/privateStorage";
import { createInterviewEventUid, createInterviewIcs } from "../services/calendar";
import { scanCandidateDocument } from "../services/documentScanner";
import { assertTransition, ensureSafeAiText, isConsequentialAction } from "../workflow";
import { consequentialRouter } from "./consequential";
import { candidateWorkflowsRouter } from "./candidateWorkflows";
import { agreementsRouter, outreachRouter } from "./outreach";

const paginationInput = z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 });
const idInput = z.object({ id: z.string().min(4).max(36) });
const stringArray = z.array(z.string().trim().min(1).max(100)).max(25);

async function requireOwned<T extends { ownerId: number }>(
  record: T | undefined,
  ownerId: number,
  label: string,
): Promise<T> {
  if (!record || record.ownerId !== ownerId) {
    throw new TRPCError({ code: "NOT_FOUND", message: `${label} was not found.` });
  }
  return record;
}

async function createApproval(input: {
  ownerId: number;
  actionType: string;
  resourceType: string;
  resourceId: string;
  reason: string;
  payload?: Record<string, unknown>;
}) {
  const db = await requireDb();
  const id = createId("apr_");
  await db.insert(approvals).values({ id, ...input, status: "pending", requestedBy: "system" });
  await recordAudit({
    ownerId: input.ownerId,
    actorType: "system",
    action: "approval.requested",
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: { actionType: input.actionType, reason: input.reason },
  });
  return id;
}

export const prospectsRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(companies).where(eq(companies.ownerId, ctx.user.id)).orderBy(desc(companies.updatedAt)).limit(input.limit);
  }),
  create: protectedProcedure.input(z.object({
    name: z.string().trim().min(2).max(255),
    domain: z.string().trim().max(255).optional(),
    sector: z.string().trim().max(120).optional(),
    location: z.string().trim().max(160).optional(),
    sourceType: z.string().trim().min(2).max(64).default("manual"),
    sourceUrl: z.string().url().optional(),
    hiringSignal: z.string().trim().max(2000).optional(),
    confidence: z.number().int().min(0).max(100).default(0),
    notes: z.string().trim().max(5000).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = createId("cmp_");
    await db.insert(companies).values({
      id,
      ownerId: ctx.user.id,
      name: input.name,
      domain: input.domain?.toLowerCase() ?? null,
      sector: input.sector ?? null,
      location: input.location ?? null,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      sourceCollectedAt: new Date(),
      hiringSignal: input.hiringSignal ?? null,
      confidence: input.confidence,
      pipelineState: "new",
      companyType: "prospect",
      verificationState: "pending",
      notes: input.notes ?? null,
    });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "company.created", resourceType: "company", resourceId: id, nextState: "new", metadata: { sourceType: input.sourceType } });
    return { id };
  }),
  transition: protectedProcedure.input(z.object({ id: z.string().min(4), state: z.string().min(2).max(48) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const record = await db.select().from(companies).where(eq(companies.id, input.id)).limit(1);
    const company = await requireOwned(record[0], ctx.user.id, "Company");
    assertTransition("company", company.pipelineState, input.state);
    await db.update(companies).set({ pipelineState: input.state, companyType: input.state === "active" ? "client" : company.companyType }).where(eq(companies.id, input.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "company.state_changed", resourceType: "company", resourceId: input.id, previousState: company.pipelineState, nextState: input.state });
    return { success: true };
  }),
  requestOnboardingApproval: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(companies).where(eq(companies.id, input.id)).limit(1);
    const company = await requireOwned(rows[0], ctx.user.id, "Company");
    if (company.pipelineState !== "converted") throw new TRPCError({ code: "BAD_REQUEST", message: "Only converted prospects can enter controlled client onboarding." });
    const approvalId = await createApproval({ ownerId: ctx.user.id, actionType: "client_onboarding", resourceType: "company", resourceId: company.id, reason: "Client onboarding requires owner confirmation." });
    return { approvalId };
  }),
  addContact: protectedProcedure.input(z.object({
    companyId: z.string().min(4), name: z.string().trim().min(2).max(160), title: z.string().trim().max(160).optional(), email: z.string().email().optional(), phone: z.string().trim().max(64).optional(), sourceUrl: z.string().url().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    await requireOwned(rows[0], ctx.user.id, "Company");
    const id = createId("con_");
    await db.insert(contacts).values({ id, ownerId: ctx.user.id, companyId: input.companyId, name: input.name, title: input.title ?? null, email: input.email?.toLowerCase() ?? null, phone: input.phone ?? null, sourceUrl: input.sourceUrl ?? null, sourceType: input.sourceUrl ? "sourced" : "manual" });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "contact.created", resourceType: "contact", resourceId: id, metadata: { companyId: input.companyId } });
    return { id };
  }),
});

export const jobsRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(jobs).where(eq(jobs.ownerId, ctx.user.id)).orderBy(desc(jobs.updatedAt)).limit(input.limit);
  }),
  create: protectedProcedure.input(z.object({
    companyId: z.string().min(4), title: z.string().trim().min(2).max(200), department: z.string().trim().max(120).optional(), location: z.string().trim().max(160).optional(), workModel: z.enum(["remote", "hybrid", "onsite"]).optional(), compensationMin: z.number().int().nonnegative().optional(), compensationMax: z.number().int().nonnegative().optional(), experienceMinYears: z.number().int().min(0).max(40).optional(), experienceMaxYears: z.number().int().min(0).max(40).optional(), mustHaveSkills: stringArray.default([]), niceToHaveSkills: stringArray.default([]), scorecard: z.array(z.object({ criterion: z.string().trim().min(2).max(160), weight: z.number().int().min(1).max(100), required: z.boolean().default(false) })).max(12).default([]),
  })).mutation(async ({ ctx, input }) => {
    for (const item of input.scorecard) {
      ensureSafeAiText(item.criterion);
    }
    if (input.compensationMin && input.compensationMax && input.compensationMin > input.compensationMax) throw new TRPCError({ code: "BAD_REQUEST", message: "Minimum compensation cannot be above maximum compensation." });
    if (input.scorecard.length && input.scorecard.reduce((sum, item) => sum + item.weight, 0) !== 100) throw new TRPCError({ code: "BAD_REQUEST", message: "Weighted scorecard criteria must total 100%." });
    if (input.experienceMinYears !== undefined && input.experienceMaxYears !== undefined && input.experienceMinYears > input.experienceMaxYears) throw new TRPCError({ code: "BAD_REQUEST", message: "Minimum experience cannot be above maximum experience." });
    const db = await requireDb();
    const companyRows = await db.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    await requireOwned(companyRows[0], ctx.user.id, "Client");
    const id = createId("job_");
    const quality = Math.min(100, 35 + input.mustHaveSkills.length * 12 + (input.location ? 10 : 0) + (input.compensationMin ? 15 : 0));
    await db.insert(jobs).values({
      id, ownerId: ctx.user.id, companyId: input.companyId, title: input.title, department: input.department ?? null, location: input.location ?? null, workModel: input.workModel ?? null,
      compensationMin: input.compensationMin ?? null, compensationMax: input.compensationMax ?? null, experienceMinYears: input.experienceMinYears ?? null, experienceMaxYears: input.experienceMaxYears ?? null,
      mustHaveSkills: input.mustHaveSkills, niceToHaveSkills: input.niceToHaveSkills, scorecard: input.scorecard, pipelineState: "draft", requirementQuality: quality,
    });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "job.created", resourceType: "job", resourceId: id, nextState: "draft", metadata: { requirementQuality: quality } });
    return { id, requirementQuality: quality };
  }),
  transition: protectedProcedure.input(z.object({ id: z.string().min(4), state: z.string().min(2).max(48), clientConfirmedBy: z.string().email().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(jobs).where(eq(jobs.id, input.id)).limit(1);
    const job = await requireOwned(rows[0], ctx.user.id, "Job");
    assertTransition("job", job.pipelineState, input.state);
    const isApprovalState = ["approved", "sourcing"].includes(input.state);
    if (isApprovalState && !job.clientConfirmedAt && !input.clientConfirmedBy) throw new TRPCError({ code: "BAD_REQUEST", message: "Client confirmation is required before activating sourcing." });
    await db.update(jobs).set({ pipelineState: input.state, clientConfirmedAt: input.clientConfirmedBy ? new Date() : job.clientConfirmedAt, clientConfirmedBy: input.clientConfirmedBy ?? job.clientConfirmedBy }).where(eq(jobs.id, job.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "job.state_changed", resourceType: "job", resourceId: job.id, previousState: job.pipelineState, nextState: input.state });
    return { success: true };
  }),
});

export const candidatesRouter = router({
  list: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(50), profileState: z.string().min(2).max(48).optional(), sourceType: z.string().min(2).max(64).optional(), availability: z.string().min(1).max(120).optional() }).default({ limit: 50 })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const filters = [eq(candidates.ownerId, ctx.user.id)];
    if (input.profileState) filters.push(eq(candidates.profileState, input.profileState));
    if (input.sourceType) filters.push(eq(candidates.sourceType, input.sourceType));
    if (input.availability) filters.push(like(candidates.availability, `%${input.availability}%`));
    return db.select().from(candidates).where(and(...filters)).orderBy(desc(candidates.updatedAt)).limit(input.limit);
  }),
  search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(100).default(50) })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const term = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    return db.select().from(candidates).where(and(eq(candidates.ownerId, ctx.user.id), or(like(candidates.fullName, term), like(candidates.headline, term), like(candidates.location, term)))).orderBy(desc(candidates.updatedAt)).limit(input.limit);
  }),
  create: protectedProcedure.input(z.object({
    fullName: z.string().trim().min(2).max(160), email: z.string().email().optional(), phone: z.string().trim().max(64).optional(), headline: z.string().trim().max(255).optional(), location: z.string().trim().max(160).optional(), availability: z.string().trim().max(120).optional(), sourceType: z.string().trim().min(2).max(64).default("manual"), sourceUrl: z.string().url().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = createId("can_");
    const email = input.email?.trim().toLowerCase();
    const phone = input.phone?.trim();
    await db.insert(candidates).values({
      id, ownerId: ctx.user.id, fullName: input.fullName, email: email ?? null, emailHash: email ? hashContactValue(email) : null, phone: phone ?? null, phoneHash: phone ? hashContactValue(phone) : null,
      headline: input.headline ?? null, location: input.location ?? null, availability: input.availability ?? null, sourceType: input.sourceType, sourceUrl: input.sourceUrl ?? null, sourceCollectedAt: new Date(), profileState: "consent_pending",
    });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.created", resourceType: "candidate", resourceId: id, nextState: "consent_pending", metadata: { sourceType: input.sourceType } });
    return { id };
  }),
  transition: protectedProcedure.input(z.object({ id: z.string().min(4), state: z.string().min(2).max(48) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(candidates).where(eq(candidates.id, input.id)).limit(1);
    const candidate = await requireOwned(rows[0], ctx.user.id, "Candidate");
    assertTransition("candidate", candidate.profileState, input.state);

    const consentRequiringStates = new Set([
      "consented",
      "available",
      "outreach_queued",
      "interested",
      "screening",
      "qualified",
      "shortlisted",
      "submitted",
      "interview",
      "offer",
      "joined",
    ]);

    if (consentRequiringStates.has(input.state)) {
      const consentRows = await db
        .select()
        .from(consents)
        .where(
          and(
            eq(consents.ownerId, ctx.user.id),
            eq(consents.candidateId, candidate.id),
            eq(consents.status, "granted"),
          )
        );
      const hasValidConsent = consentRows.some(
        c =>
          (!c.expiresAt || c.expiresAt > new Date()) &&
          (c.consentType === "platform_processing" ||
            c.consentType === "recruitment_communication" ||
            c.consentType === "client_sharing" ||
            c.consentType === "interview_processing")
      );
      if (!hasValidConsent) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Explicit candidate consent (of at least consentType 'platform_processing') is required before transitioning to a consented state.",
        });
      }
    }

    await db.update(candidates).set({ profileState: input.state }).where(eq(candidates.id, candidate.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.state_changed", resourceType: "candidate", resourceId: candidate.id, previousState: candidate.profileState, nextState: input.state });
    return { success: true };
  }),
  grantConsent: protectedProcedure.input(z.object({ candidateId: z.string().min(4), consentType: z.enum(["platform_processing", "recruitment_communication", "client_sharing", "interview_processing", "recording", "background_check", "marketing"]), jobId: z.string().min(4).optional(), companyId: z.string().min(4).optional(), noticeVersion: z.string().trim().min(1).max(64).default("v1"), expiresAt: z.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
    const candidate = await requireOwned(rows[0], ctx.user.id, "Candidate");
    if (input.consentType === "client_sharing" && (!input.jobId || !input.companyId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Client sharing consent must be linked to both a job and client." });
    const id = createId("cns_");
    await db.insert(consents).values({ id, ownerId: ctx.user.id, candidateId: candidate.id, jobId: input.jobId ?? null, companyId: input.companyId ?? null, consentType: input.consentType, status: "granted", noticeVersion: input.noticeVersion, method: "owner_recorded", grantedAt: new Date(), expiresAt: input.expiresAt ?? null, dataScope: { purpose: input.consentType } });
    const nextState = candidate.profileState === "consent_pending" ? "consented" : candidate.profileState;
    if (nextState !== candidate.profileState) await db.update(candidates).set({ profileState: nextState }).where(eq(candidates.id, candidate.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.consent_granted", resourceType: "candidate", resourceId: candidate.id, previousState: candidate.profileState, nextState, metadata: { consentType: input.consentType, consentId: id } });
    return { id };
  }),
  withdraw: protectedProcedure.input(z.object({ candidateId: z.string().min(4), reason: z.string().trim().max(500).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
    const candidate = await requireOwned(rows[0], ctx.user.id, "Candidate");
    await db.update(candidates).set({ profileState: "withdrawn", withdrawnAt: new Date() }).where(eq(candidates.id, candidate.id));
    await db.update(consents).set({ status: "withdrawn", withdrawnAt: new Date() }).where(and(eq(consents.ownerId, ctx.user.id), eq(consents.candidateId, candidate.id), eq(consents.status, "granted")));
    if (candidate.emailHash) await db.insert(suppressionList).values({ id: createId("sup_"), ownerId: ctx.user.id, channel: "email", valueHash: candidate.emailHash, reason: input.reason ?? "candidate_withdrawal", source: "candidate_rights" }).onDuplicateKeyUpdate({ set: { active: true, reason: input.reason ?? "candidate_withdrawal" } });
    await db.update(shortlists).set({ status: "withdrawn" }).where(and(eq(shortlists.ownerId, ctx.user.id), eq(shortlists.candidateId, candidate.id)));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.withdrawn", resourceType: "candidate", resourceId: candidate.id, previousState: candidate.profileState, nextState: "withdrawn", metadata: { reason: input.reason ?? null } });
    return { success: true };
  }),
  doNotContact: protectedProcedure.input(z.object({ candidateId: z.string().min(4), reason: z.string().trim().min(2).max(500) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
    const candidate = await requireOwned(rows[0], ctx.user.id, "Candidate");
    await db.update(candidates).set({ profileState: "do_not_contact", doNotContactAt: new Date() }).where(eq(candidates.id, candidate.id));
    if (candidate.emailHash) await db.insert(suppressionList).values({ id: createId("sup_"), ownerId: ctx.user.id, channel: "email", valueHash: candidate.emailHash, reason: input.reason, source: "owner" }).onDuplicateKeyUpdate({ set: { active: true, reason: input.reason } });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.do_not_contact", resourceType: "candidate", resourceId: candidate.id, previousState: candidate.profileState, nextState: "do_not_contact", metadata: { reason: input.reason } });
    return { success: true };
  }),
  requestRights: protectedProcedure.input(z.object({ candidateId: z.string().min(4), requestType: z.enum(["access", "correction", "withdrawal", "deletion", "complaint"]), details: z.string().trim().min(3).max(4000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const candidate = await requireOwned((await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1))[0], ctx.user.id, "Candidate");
    const id = createId("rgt_");
    await db.insert(rightsRequests).values({ id, ownerId: ctx.user.id, candidateId: candidate.id, requestType: input.requestType, details: input.details });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.rights_request_created", resourceType: "rights_request", resourceId: id, nextState: "received", metadata: { candidateId: candidate.id, requestType: input.requestType } });
    return { id };
  }),
  documents: router({
    list: protectedProcedure.input(z.object({ candidateId: z.string().min(4).optional() }).optional()).query(async ({ ctx, input }) => {
      const db = await requireDb();
      if (input?.candidateId) {
        const candidateRows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
        await requireOwned(candidateRows[0], ctx.user.id, "Candidate");
        return db.select().from(candidateDocuments).where(and(eq(candidateDocuments.ownerId, ctx.user.id), eq(candidateDocuments.candidateId, input.candidateId))).orderBy(desc(candidateDocuments.createdAt));
      }
      return db.select().from(candidateDocuments).where(eq(candidateDocuments.ownerId, ctx.user.id)).orderBy(desc(candidateDocuments.createdAt));
    }),
    access: protectedProcedure.input(z.object({ documentId: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const document = (await db.select().from(candidateDocuments).where(and(eq(candidateDocuments.id, input.documentId), eq(candidateDocuments.ownerId, ctx.user.id))).limit(1))[0];
      if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate document was not found." });
      if (document.scanState !== "clean") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            document.scanState === "flagged"
              ? "Document was flagged during security scanning and cannot be accessed."
              : "Document is pending security scanning and cannot be accessed yet.",
        });
      }
      const url = await getPrivateDocumentUrl(document.storageKey, 300);
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.actor?.id ?? ctx.user.id), action: "candidate.document_access_granted", resourceType: "candidate_document", resourceId: document.id, metadata: { expiresInSeconds: 300 } });
      return { url, expiresAt: new Date(Date.now() + 300_000) };
    }),
    scan: protectedProcedure.input(z.object({ documentId: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const document = (await db.select().from(candidateDocuments).where(and(eq(candidateDocuments.id, input.documentId), eq(candidateDocuments.ownerId, ctx.user.id))).limit(1))[0];
      if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate document was not found." });
      return scanCandidateDocument(document.id, ctx.user.id);
    }),
    upload: protectedProcedure.input(z.object({
      candidateId: z.string().min(4),
      originalName: z.string().trim().min(1).max(255),
      mimeType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]),
      dataBase64: z.string().min(16).max(7_000_000),
      documentType: z.enum(["cv", "portfolio", "offer", "identity", "other"]).default("cv"),
    })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const candidateRows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
      const candidate = await requireOwned(candidateRows[0], ctx.user.id, "Candidate");
      const bytes = Buffer.from(input.dataBase64, "base64");
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Candidate documents must be no larger than 5 MB." });
      const safeName = input.originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uploaded = await putPrivateDocument(`private/${ctx.user.id}/candidates/${candidate.id}/${safeName}`, bytes, input.mimeType);
      const id = createId("doc_");
      await db.insert(candidateDocuments).values({
        id, candidateId: candidate.id, ownerId: ctx.user.id, documentType: input.documentType, storageKey: uploaded.key, storageUrl: uploaded.url,
        originalName: safeName, mimeType: input.mimeType, sizeBytes: bytes.length, sha256, scanState: "accepted_pending_scan", parseState: input.documentType === "cv" ? "queued" : "not_requested",
        provenance: { source: "owner_upload", uploadedBy: ctx.user.id, uploadedAt: new Date().toISOString() },
      });
      // Queue security scanning job
      await db.insert(automationQueue).values({
        id: createId("que_"),
        ownerId: ctx.user.id,
        jobType: "scan_document",
        payload: { candidateId: candidate.id, documentId: id },
        priority: 1,
        scheduledAt: new Date(),
        maxAttempts: 3,
        idempotencyKey: `scan_document:${id}`,
      });
      if (input.documentType === "cv") {
        try {
          const extractedText = await extractDocumentText(bytes, input.mimeType);
          await db.insert(automationQueue).values({
            id: createId("que_"), ownerId: ctx.user.id, jobType: "parse_cv", payload: { candidateId: candidate.id, documentId: id, cvText: extractedText }, idempotencyKey: `parse_cv:${id}`,
          });
        } catch (error) {
          await db.update(candidateDocuments).set({ parseState: "blocked" }).where(eq(candidateDocuments.id, id));
          await recordAudit({ ownerId: ctx.user.id, actorType: "system", action: "candidate.document_parse_blocked", resourceType: "candidate_document", resourceId: id, metadata: { error: error instanceof Error ? error.message : "Document extraction failed." } });
        }
      }
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "candidate.document_uploaded", resourceType: "candidate_document", resourceId: id, metadata: { candidateId: candidate.id, documentType: input.documentType, sha256 } });
      return { id, storageUrl: uploaded.url };
    }),
  }),
});

export const matchingRouter = router({
  listForJob: protectedProcedure.input(z.object({ jobId: z.string().min(4) })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const jobRows = await db.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
    await requireOwned(jobRows[0], ctx.user.id, "Job");
    return db.select().from(matches).where(and(eq(matches.ownerId, ctx.user.id), eq(matches.jobId, input.jobId))).orderBy(desc(matches.ruleScore));
  }),
  createEvidenceMatch: protectedProcedure.input(z.object({ candidateId: z.string().min(4), jobId: z.string().min(4), ruleScore: z.number().int().min(0).max(100), semanticScore: z.number().int().min(0).max(100), confidence: z.number().int().min(0).max(100), evidence: z.array(z.string().trim().min(2).max(500)).min(1).max(12), missingEvidence: z.array(z.string().trim().min(2).max(500)).max(12).default([]) })).mutation(async ({ ctx, input }) => {
    for (const item of input.evidence) {
      ensureSafeAiText(item);
    }
    for (const item of input.missingEvidence) {
      ensureSafeAiText(item);
    }
    const db = await requireDb();
    const candidateRows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
    await requireOwned(candidateRows[0], ctx.user.id, "Candidate");
    const jobRows = await db.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
    await requireOwned(jobRows[0], ctx.user.id, "Job");
    const id = createId("mat_");
    const lowConfidence = input.confidence < 70 || input.missingEvidence.length > 0;
    await db.insert(matches).values({ id, ownerId: ctx.user.id, candidateId: input.candidateId, jobId: input.jobId, status: lowConfidence ? "low_confidence" : "evidence_validated", ruleScore: input.ruleScore, semanticScore: input.semanticScore, confidence: input.confidence, evidence: input.evidence, missingEvidence: input.missingEvidence, lowConfidence, modelRoute: "controlled_evidence" }).onDuplicateKeyUpdate({ set: { ruleScore: input.ruleScore, semanticScore: input.semanticScore, confidence: input.confidence, evidence: input.evidence, missingEvidence: input.missingEvidence, lowConfidence, status: lowConfidence ? "low_confidence" : "evidence_validated" } });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "match.evidence_recorded", resourceType: "match", resourceId: id, metadata: { candidateId: input.candidateId, jobId: input.jobId, lowConfidence } });
    return { id, lowConfidence };
  }),
  requestShareApproval: protectedProcedure.input(z.object({ candidateId: z.string().min(4), jobId: z.string().min(4), companyId: z.string().min(4), matchId: z.string().min(4).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const candidateRows = await db.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
    await requireOwned(candidateRows[0], ctx.user.id, "Candidate");
    const consentRows = await db.select().from(consents).where(and(eq(consents.ownerId, ctx.user.id), eq(consents.candidateId, input.candidateId), eq(consents.jobId, input.jobId), eq(consents.companyId, input.companyId), eq(consents.consentType, "client_sharing"), eq(consents.status, "granted"))).limit(1);
    if (!consentRows[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Explicit candidate client-sharing consent is required before a shortlist can be shared." });
    const shortlistId = createId("shl_");
    await db.insert(shortlists).values({ id: shortlistId, ownerId: ctx.user.id, companyId: input.companyId, jobId: input.jobId, candidateId: input.candidateId, matchId: input.matchId ?? null, status: "prepared", consentId: consentRows[0].id });
    const approvalId = await createApproval({ ownerId: ctx.user.id, actionType: "candidate_share", resourceType: "shortlist", resourceId: shortlistId, reason: "Candidate profile sharing requires owner approval and verified consent." });
    return { shortlistId, approvalId };
  }),
});

export const interviewsRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(interviews).where(eq(interviews.ownerId, ctx.user.id)).orderBy(desc(interviews.scheduledAt)).limit(input.limit);
  }),
  enableReminderSchedule: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.actor && ctx.actor.id !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage reminder schedules." });
    const db = await requireDb();
    const cookie = parseCookieHeader(ctx.req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
    if (!cookie) throw new TRPCError({ code: "UNAUTHORIZED", message: "A session cookie is required to create a schedule." });
    const job = await createHeartbeatJob({ name: `interview-reminders-${ctx.user.id}`, cron: "0 */5 * * * *", path: "/api/scheduled/interview-reminders", description: "Queue due interview reminder drafts every five minutes." }, cookie);
    await db.update(workspaceSettings).set({ scheduleCronTaskUid: job.taskUid }).where(eq(workspaceSettings.ownerId, ctx.user.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.reminder_schedule_enabled", resourceType: "workspace", resourceId: String(ctx.user.id), metadata: { taskUid: job.taskUid, cron: "0 */5 * * * *" } });
    return job;
  }),
  create: protectedProcedure.input(z.object({ companyId: z.string().min(4), candidateId: z.string().min(4), jobId: z.string().min(4), scheduledAt: z.date(), timezone: z.string().trim().min(2).max(64).default("Asia/Kolkata"), durationMinutes: z.number().int().min(15).max(240).default(45), meetingUrl: z.string().url().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = createId("int_");
    await db.insert(interviews).values({ id, ownerId: ctx.user.id, companyId: input.companyId, candidateId: input.candidateId, jobId: input.jobId, status: "scheduled", scheduledAt: input.scheduledAt, timezone: input.timezone, durationMinutes: input.durationMinutes, meetingUrl: input.meetingUrl ?? null, calendarProvider: "ics", calendarEventId: createInterviewEventUid(id), calendarStatus: "tentative", calendarSequence: 0, reminderAt: new Date(input.scheduledAt.getTime() - 24 * 60 * 60 * 1000) });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.scheduled", resourceType: "interview", resourceId: id, nextState: "scheduled" });
    return { id };
  }),
  exportIcs: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const interview = await requireOwned((await db.select().from(interviews).where(eq(interviews.id, input.id)).limit(1))[0], ctx.user.id, "Interview");
    if (!interview.scheduledAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Interview has no scheduled time." });
    const content = createInterviewIcs({ uid: interview.calendarEventId ?? createInterviewEventUid(interview.id), sequence: interview.calendarSequence, start: interview.scheduledAt, end: new Date(interview.scheduledAt.getTime() + interview.durationMinutes * 60_000), summary: `FreelanceHR interview ${interview.id.slice(-6)}`, description: `Interview status: ${interview.status}. Timezone: ${interview.timezone}.`, location: interview.meetingUrl, status: interview.calendarStatus === "cancelled" ? "CANCELLED" : interview.calendarStatus === "confirmed" ? "CONFIRMED" : "TENTATIVE" });
    return { content, filename: `freelancehr-interview-${interview.id}.ics`, calendarStatus: interview.calendarStatus, sequence: interview.calendarSequence };
  }),
  setReminder: protectedProcedure.input(z.object({ id: z.string().min(4), reminderAt: z.date().nullable() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const interview = await requireOwned((await db.select().from(interviews).where(eq(interviews.id, input.id)).limit(1))[0], ctx.user.id, "Interview");
    if (interview.calendarStatus === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cancelled interviews cannot receive reminders." });
    await db.update(interviews).set({ reminderAt: input.reminderAt, reminderSentAt: null }).where(eq(interviews.id, interview.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.reminder_configured", resourceType: "interview", resourceId: interview.id, metadata: { reminderAt: input.reminderAt?.toISOString() ?? null } });
    return { success: true };
  }),
  reschedule: protectedProcedure.input(z.object({ id: z.string().min(4), scheduledAt: z.date(), timezone: z.string().trim().min(2).max(64), durationMinutes: z.number().int().min(15).max(240), meetingUrl: z.string().url().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const interview = await requireOwned((await db.select().from(interviews).where(eq(interviews.id, input.id)).limit(1))[0], ctx.user.id, "Interview");
    assertTransition("interview", interview.status, "reschedule_requested");
    await db.update(interviews).set({ status: "scheduled", scheduledAt: input.scheduledAt, timezone: input.timezone, durationMinutes: input.durationMinutes, meetingUrl: input.meetingUrl ?? null, calendarSequence: interview.calendarSequence + 1, calendarStatus: "tentative", rescheduleCount: interview.rescheduleCount + 1, reminderAt: new Date(input.scheduledAt.getTime() - 24 * 60 * 60 * 1000), reminderSentAt: null }).where(eq(interviews.id, interview.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.rescheduled", resourceType: "interview", resourceId: interview.id, previousState: interview.status, nextState: "scheduled", metadata: { calendarSequence: interview.calendarSequence + 1 } });
    return { success: true };
  }),
  cancel: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const interview = await requireOwned((await db.select().from(interviews).where(eq(interviews.id, input.id)).limit(1))[0], ctx.user.id, "Interview");
    assertTransition("interview", interview.status, "cancelled");
    await db.update(interviews).set({ status: "cancelled", calendarStatus: "cancelled", calendarSequence: interview.calendarSequence + 1, reminderAt: null }).where(eq(interviews.id, interview.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.cancelled", resourceType: "interview", resourceId: interview.id, previousState: interview.status, nextState: "cancelled", metadata: { calendarSequence: interview.calendarSequence + 1 } });
    return { success: true };
  }),
  transition: protectedProcedure.input(z.object({ id: z.string().min(4), state: z.string().min(2).max(48) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(interviews).where(eq(interviews.id, input.id)).limit(1);
    const interview = await requireOwned(rows[0], ctx.user.id, "Interview");
    assertTransition("interview", interview.status, input.state);
    await db.update(interviews).set({ status: input.state, completedAt: input.state === "completed" ? new Date() : interview.completedAt, calendarStatus: input.state === "confirmed" ? "confirmed" : input.state === "cancelled" ? "cancelled" : interview.calendarStatus }).where(eq(interviews.id, input.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.state_changed", resourceType: "interview", resourceId: input.id, previousState: interview.status, nextState: input.state });
    return { success: true };
  }),
});

export const feedbackRouter = router({
  list: protectedProcedure.input(z.object({ interviewId: z.string().min(4) })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const interview = (await db.select().from(interviews).where(and(eq(interviews.id, input.interviewId), eq(interviews.ownerId, ctx.user.id))).limit(1))[0];
    if (!interview) throw new TRPCError({ code: "NOT_FOUND", message: "Interview was not found." });
    return db.select().from(feedback).where(and(eq(feedback.interviewId, input.interviewId), eq(feedback.ownerId, ctx.user.id))).orderBy(desc(feedback.submittedAt));
  }),
  record: protectedProcedure.input(z.object({
    interviewId: z.string().min(4),
    authorName: z.string().trim().min(2).max(160),
    rawFeedback: z.string().trim().min(12).max(12000),
    technicalScore: z.number().int().min(1).max(5).optional(),
    communicationScore: z.number().int().min(1).max(5).optional(),
    roleEvidence: z.array(z.string().trim().min(2).max(500)).max(10).default([]),
  })).mutation(async ({ ctx, input }) => {
    ensureSafeAiText(input.rawFeedback);
    for (const item of input.roleEvidence) {
      ensureSafeAiText(item);
    }
    const db = await requireDb();
    const interview = (await db.select().from(interviews).where(and(eq(interviews.id, input.interviewId), eq(interviews.ownerId, ctx.user.id))).limit(1))[0];
    if (!interview) throw new TRPCError({ code: "NOT_FOUND", message: "Interview was not found." });
    if (!["completed", "feedback_pending", "feedback_received"].includes(interview.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Feedback can only be recorded for a completed interview." });
    const id = createId("fbk_");
    await db.insert(feedback).values({ id, ownerId: ctx.user.id, interviewId: interview.id, authorName: input.authorName, rawFeedback: input.rawFeedback, scorecard: { technicalScore: input.technicalScore ?? null, communicationScore: input.communicationScore ?? null, roleEvidence: input.roleEvidence } });
    if (interview.status !== "feedback_received") await db.update(interviews).set({ status: "feedback_received" }).where(eq(interviews.id, interview.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "interview.feedback_recorded", resourceType: "interview", resourceId: interview.id, previousState: interview.status, nextState: "feedback_received", metadata: { feedbackId: id } });
    return { id };
  }),
});

export const placementsRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(placements).where(eq(placements.ownerId, ctx.user.id)).orderBy(desc(placements.updatedAt)).limit(input.limit);
  }),
  create: protectedProcedure.input(z.object({ companyId: z.string().min(4), candidateId: z.string().min(4), jobId: z.string().min(4), annualCompensation: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = createId("plc_");
    await db.insert(placements).values({ id, ownerId: ctx.user.id, companyId: input.companyId, candidateId: input.candidateId, jobId: input.jobId, annualCompensation: input.annualCompensation ?? null, status: "offer_pending" });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "placement.created", resourceType: "placement", resourceId: id, nextState: "offer_pending" });
    return { id };
  }),
  transition: protectedProcedure.input(z.object({ id: z.string().min(4), state: z.string().min(2).max(48), joiningEvidence: z.array(z.string().trim().min(2).max(500)).max(5).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(placements).where(eq(placements.id, input.id)).limit(1);
    const placement = await requireOwned(rows[0], ctx.user.id, "Placement");
    assertTransition("placement", placement.status, input.state);
    if (["joining_confirmed", "invoice_eligible"].includes(input.state) && (!input.joiningEvidence || input.joiningEvidence.length === 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "Joining evidence is required before confirming placement or invoice eligibility." });
    if (isConsequentialAction("placement_confirmation") && input.state === "joining_confirmed") {
      const approvalId = await createApproval({ ownerId: ctx.user.id, actionType: "placement_confirmation", resourceType: "placement", resourceId: placement.id, reason: "Placement confirmation is consequential and requires owner approval.", payload: { requestedState: input.state, joiningEvidence: input.joiningEvidence ?? [] } });
      return { approvalId, approvalRequired: true };
    }
    await db.update(placements).set({ status: input.state, joiningEvidence: input.joiningEvidence ?? placement.joiningEvidence, joiningConfirmedAt: input.state === "joining_confirmed" ? new Date() : placement.joiningConfirmedAt, guaranteeStartAt: input.state === "guarantee_active" ? new Date() : placement.guaranteeStartAt }).where(eq(placements.id, placement.id));
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "placement.state_changed", resourceType: "placement", resourceId: placement.id, previousState: placement.status, nextState: input.state });
    return { success: true, approvalRequired: false };
  }),
});

export const invoicesRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(invoices).where(eq(invoices.ownerId, ctx.user.id)).orderBy(desc(invoices.updatedAt)).limit(input.limit);
  }),
  draft: protectedProcedure.input(z.object({ placementId: z.string().min(4), companyId: z.string().min(4), invoiceNumber: z.string().trim().min(3).max(64), amount: z.number().int().positive(), taxAmount: z.number().int().nonnegative().default(0), dueAt: z.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(placements).where(eq(placements.id, input.placementId)).limit(1);
    const placement = await requireOwned(rows[0], ctx.user.id, "Placement");
    if (!["invoice_eligible", "guarantee_active"].includes(placement.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A placement must be invoice-eligible before a draft invoice can be created." });
    const existingInvoices = await db.select().from(invoices).where(and(eq(invoices.placementId, input.placementId), eq(invoices.ownerId, ctx.user.id)));
    const activeInvoice = existingInvoices.find(inv => !["credited", "written_off", "cancelled", "closed"].includes(inv.status));
    if (activeInvoice) {
      if (activeInvoice.status === "paid") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This placement has already been paid and cannot be re-invoiced." });
      }
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Placement already has an active invoice (${activeInvoice.invoiceNumber}) in status "${activeInvoice.status}". Only one non-terminal invoice is allowed per placement at a time.`,
      });
    }
    const id = createId("inv_");
    await db.insert(invoices).values({ id, ownerId: ctx.user.id, companyId: input.companyId, placementId: input.placementId, invoiceNumber: input.invoiceNumber, amount: input.amount, taxAmount: input.taxAmount, dueAt: input.dueAt ?? null, status: "draft" });
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "invoice.drafted", resourceType: "invoice", resourceId: id, nextState: "draft" });
    return { id };
  }),
  requestIssueApproval: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(invoices).where(eq(invoices.id, input.id)).limit(1);
    const invoice = await requireOwned(rows[0], ctx.user.id, "Invoice");
    if (!["draft", "validation", "approval_pending"].includes(invoice.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a draft invoice can be submitted for issue approval." });
    await db.update(invoices).set({ status: "approval_pending" }).where(eq(invoices.id, invoice.id));
    const approvalId = await createApproval({ ownerId: ctx.user.id, actionType: "invoice_issue", resourceType: "invoice", resourceId: invoice.id, reason: "Invoice issuance requires owner approval.", payload: { amount: invoice.amount, taxAmount: invoice.taxAmount } });
    return { approvalId };
  }),
});

export const approvalsRouter = router({
  list: protectedProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select().from(approvals).where(eq(approvals.ownerId, ctx.user.id)).orderBy(desc(approvals.createdAt)).limit(input.limit);
  }),
  decide: protectedProcedure.input(z.object({ id: z.string().min(4), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const rows = await db.select().from(approvals).where(eq(approvals.id, input.id)).limit(1);
    const approval = await requireOwned(rows[0], ctx.user.id, "Approval");
    if (approval.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "This approval has already been decided." });
    await db.update(approvals).set({ status: input.decision, decidedById: ctx.user.id, decidedAt: new Date(), reason: input.note ?? approval.reason }).where(eq(approvals.id, approval.id));
    if (input.decision === "approved" && approval.actionType === "client_onboarding") {
      await db.update(companies).set({ pipelineState: "active", companyType: "client", verificationState: "verified", onboardingApprovedAt: new Date(), onboardingApprovedById: ctx.user.id }).where(and(eq(companies.id, approval.resourceId), eq(companies.ownerId, ctx.user.id)));
    }
    if (input.decision === "approved" && approval.actionType === "candidate_share") {
      await db.update(shortlists).set({ status: "shared", sharedAt: new Date(), shareExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14) }).where(and(eq(shortlists.id, approval.resourceId), eq(shortlists.ownerId, ctx.user.id)));
    }
    if (input.decision === "approved" && approval.actionType === "placement_confirmation") {
      await db.update(placements).set({ status: "joining_confirmed", joiningConfirmedAt: new Date(), joiningEvidence: (approval.payload as { joiningEvidence?: string[] } | null)?.joiningEvidence ?? null }).where(and(eq(placements.id, approval.resourceId), eq(placements.ownerId, ctx.user.id)));
    }
    if (input.decision === "approved" && approval.actionType === "invoice_issue") {
      await db.update(invoices).set({ status: "issued", issuedAt: new Date() }).where(and(eq(invoices.id, approval.resourceId), eq(invoices.ownerId, ctx.user.id)));
    }
    await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: `approval.${input.decision}`, resourceType: approval.resourceType, resourceId: approval.resourceId, metadata: { actionType: approval.actionType, approvalId: approval.id } });
    return { success: true };
  }),
});

export const recruitmentRouter = router({
  prospects: prospectsRouter,
  outreach: outreachRouter,
  agreements: agreementsRouter,
  jobs: jobsRouter,
  candidates: candidatesRouter,
  candidateWorkflows: candidateWorkflowsRouter,
  matching: matchingRouter,
  interviews: interviewsRouter,
  feedback: feedbackRouter,
  consequential: consequentialRouter,
  placements: placementsRouter,
  invoices: invoicesRouter,
  approvals: approvalsRouter,
  workspace: router({
    bootstrap: protectedProcedure.mutation(async ({ ctx }) => ({ workspace: await ensureWorkspace(ctx.user.id) })),
  }),
});
