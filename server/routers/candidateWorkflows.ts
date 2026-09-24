import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  candidateDocuments,
  candidates,
  consents,
  interviews,
  matches,
  placements,
  rightsRequests,
  screenings,
  shortlists,
  suppressionList,
} from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { assertTransition, ensureSafeAiText } from "../workflow";
import { deletePrivateDocument } from "../services/privateStorage";

function validateSafeTextValue(val: unknown) {
  if (typeof val === "string") {
    ensureSafeAiText(val);
  } else if (Array.isArray(val)) {
    for (const item of val) {
      validateSafeTextValue(item);
    }
  } else if (val && typeof val === "object") {
    for (const item of Object.values(val as Record<string, unknown>)) {
      validateSafeTextValue(item);
    }
  }
}

export const candidateWorkflowsRouter = router({
  screenings: router({
    list: protectedProcedure.input(z.object({ jobId: z.string().min(4).optional(), candidateId: z.string().min(4).optional(), limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const filters = [eq(screenings.ownerId, ctx.user.id)];
      if (input.jobId) filters.push(eq(screenings.jobId, input.jobId));
      if (input.candidateId) filters.push(eq(screenings.candidateId, input.candidateId));
      return db.select().from(screenings).where(and(...filters)).orderBy(desc(screenings.updatedAt)).limit(input.limit);
    }),
    create: protectedProcedure.input(z.object({ candidateId: z.string().min(4), jobId: z.string().min(4), answers: z.record(z.string(), z.unknown()), evidence: z.array(z.string().trim().min(2).max(500)).max(20).default([]), confidence: z.number().int().min(0).max(100).default(0) })).mutation(async ({ ctx, input }) => {
      for (const item of input.evidence) {
        ensureSafeAiText(item);
      }
      for (const val of Object.values(input.answers)) {
        validateSafeTextValue(val);
      }
      const db = await requireDb();
      const id = createId("scr_");
      await db.insert(screenings).values({ id, ownerId: ctx.user.id, candidateId: input.candidateId, jobId: input.jobId, status: "in_progress", answers: input.answers, evidence: input.evidence, confidence: input.confidence });
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "screening.created", resourceType: "screening", resourceId: id, nextState: "in_progress" });
      return { id };
    }),
    updateState: protectedProcedure.input(z.object({ id: z.string().min(4), status: z.enum(["in_progress", "evidence_pending", "ready_for_owner_decision", "closed"]) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const record = (await db.select().from(screenings).where(and(eq(screenings.id, input.id), eq(screenings.ownerId, ctx.user.id))).limit(1))[0];
      if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Screening was not found." });
      assertTransition("screening", record.status, input.status);
      await db.update(screenings).set({ status: input.status }).where(eq(screenings.id, record.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "screening.state_changed", resourceType: "screening", resourceId: record.id, previousState: record.status, nextState: input.status });
      return { success: true };
    }),
  }),
  shortlists: router({
    list: protectedProcedure.input(z.object({ jobId: z.string().min(4).optional(), limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const filters = [eq(shortlists.ownerId, ctx.user.id)];
      if (input.jobId) filters.push(eq(shortlists.jobId, input.jobId));
      return db.select().from(shortlists).where(and(...filters)).orderBy(desc(shortlists.createdAt)).limit(input.limit);
    }),
    updateNote: protectedProcedure.input(z.object({ id: z.string().min(4), clientFeedback: z.string().trim().max(4000) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const shortlist = (await db.select().from(shortlists).where(and(eq(shortlists.id, input.id), eq(shortlists.ownerId, ctx.user.id))).limit(1))[0];
      if (!shortlist) throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist was not found." });
      if (shortlist.status === "shared") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A shared shortlist cannot be altered; prepare a new controlled share instead." });
      await db.update(shortlists).set({ clientFeedback: input.clientFeedback }).where(eq(shortlists.id, shortlist.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "shortlist.feedback_updated", resourceType: "shortlist", resourceId: shortlist.id });
      return { success: true };
    }),
    updateState: protectedProcedure.input(z.object({ id: z.string().min(4), status: z.enum(["approval_pending", "shared", "viewed", "withdrawn", "expired"]) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const shortlist = (await db.select().from(shortlists).where(and(eq(shortlists.id, input.id), eq(shortlists.ownerId, ctx.user.id))).limit(1))[0];
      if (!shortlist) throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist was not found." });
      assertTransition("shortlist", shortlist.status, input.status);
      await db.update(shortlists).set({ status: input.status }).where(eq(shortlists.id, shortlist.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "shortlist.state_changed", resourceType: "shortlist", resourceId: shortlist.id, previousState: shortlist.status, nextState: input.status });
      return { success: true };
    }),
  }),
  privacy: router({
    pendingRights: protectedProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      return db.select().from(rightsRequests).where(and(eq(rightsRequests.ownerId, ctx.user.id), eq(rightsRequests.status, "received"))).orderBy(desc(rightsRequests.receivedAt));
    }),
    fulfillCorrection: protectedProcedure.input(z.object({ requestId: z.string().min(4), fullName: z.string().trim().min(2).max(160).optional(), headline: z.string().trim().max(255).optional(), location: z.string().trim().max(160).optional(), availability: z.string().trim().max(120).optional(), resolutionNote: z.string().trim().min(3).max(2000) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const request = (await db.select().from(rightsRequests).where(and(eq(rightsRequests.id, input.requestId), eq(rightsRequests.ownerId, ctx.user.id))).limit(1))[0];
      if (!request || request.requestType !== "correction" || request.status !== "received") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An open correction request is required." });
      assertTransition("rights_request", request.status, "resolved");
      const patch = { ...(input.fullName ? { fullName: input.fullName } : {}), ...(input.headline ? { headline: input.headline } : {}), ...(input.location ? { location: input.location } : {}), ...(input.availability ? { availability: input.availability } : {}) };
      if (!Object.keys(patch).length) throw new TRPCError({ code: "BAD_REQUEST", message: "Provide at least one corrected profile field." });
      await db.update(candidates).set(patch).where(and(eq(candidates.id, request.candidateId), eq(candidates.ownerId, ctx.user.id)));
      await db.update(rightsRequests).set({ status: "resolved", resolvedAt: new Date(), details: `${request.details}\nResolution: ${input.resolutionNote}` }).where(eq(rightsRequests.id, request.id));
      await recordAudit({ ownerId: ctx.user.id, actorType: "user", actorId: String(ctx.user.id), action: "privacy.correction_fulfilled", resourceType: "rights_request", resourceId: request.id, previousState: "received", nextState: "resolved", metadata: { candidateId: request.candidateId } });
      return { success: true };
    }),
    fulfillDeletion: protectedProcedure.input(z.object({ requestId: z.string().min(4), resolutionNote: z.string().trim().min(3).max(2000) })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const request = (await db.select().from(rightsRequests).where(and(eq(rightsRequests.id, input.requestId), eq(rightsRequests.ownerId, ctx.user.id))).limit(1))[0];
      if (!request || request.requestType !== "deletion" || request.status !== "received") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An open deletion request is required." });

      const candidate = (await db.select().from(candidates).where(and(eq(candidates.id, request.candidateId), eq(candidates.ownerId, ctx.user.id))).limit(1))[0];
      if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate was not found." });

      // 1. Capture contact hashes before PII redaction for suppression
      const emailHash = candidate.emailHash;
      const phoneHash = candidate.phoneHash;

      // 2. Validate candidate deletion transition per workflow FSM
      // (Explicitly widened reachability enables statutory GDPR/DPDP right-to-erasure from any state)
      assertTransition("candidate", candidate.profileState, "deleted");

      // 3. Cascade deletion to connected open interviews
      const candidateInterviews = await db.select().from(interviews).where(and(eq(interviews.candidateId, candidate.id), eq(interviews.ownerId, ctx.user.id)));
      for (const interview of candidateInterviews) {
        if (interview.status === "cancelled" || interview.status === "closed") continue;
        const targetState = ["completed", "feedback_pending", "feedback_received", "no_show"].includes(interview.status) ? "closed" : "cancelled";
        assertTransition("interview", interview.status, targetState);
        await db.update(interviews).set({ status: targetState, ...(targetState === "cancelled" ? { calendarStatus: "cancelled" } : {}) }).where(eq(interviews.id, interview.id));
        await recordAudit({
          ownerId: ctx.user.id,
          actorType: "user",
          actorId: String(ctx.user.id),
          action: "interview.state_changed",
          resourceType: "interview",
          resourceId: interview.id,
          previousState: interview.status,
          nextState: targetState,
          metadata: { reason: "candidate_deletion_cascade", candidateId: candidate.id },
        });
      }

      // 4. Cascade deletion to connected open shortlists
      const candidateShortlists = await db.select().from(shortlists).where(and(eq(shortlists.candidateId, candidate.id), eq(shortlists.ownerId, ctx.user.id)));
      for (const shortlist of candidateShortlists) {
        if (shortlist.status === "withdrawn" || shortlist.status === "expired") continue;
        assertTransition("shortlist", shortlist.status, "withdrawn");
        await db.update(shortlists).set({ status: "withdrawn" }).where(eq(shortlists.id, shortlist.id));
        await recordAudit({
          ownerId: ctx.user.id,
          actorType: "user",
          actorId: String(ctx.user.id),
          action: "shortlist.state_changed",
          resourceType: "shortlist",
          resourceId: shortlist.id,
          previousState: shortlist.status,
          nextState: "withdrawn",
          metadata: { reason: "candidate_deletion_cascade", candidateId: candidate.id },
        });
      }

      // 5. Cascade deletion to connected open matches
      const candidateMatches = await db.select().from(matches).where(and(eq(matches.candidateId, candidate.id), eq(matches.ownerId, ctx.user.id)));
      for (const match of candidateMatches) {
        if (match.status === "closed" || match.status === "withdrawn") continue;
        assertTransition("match", match.status, "closed");
        await db.update(matches).set({ status: "closed" }).where(eq(matches.id, match.id));
        await recordAudit({
          ownerId: ctx.user.id,
          actorType: "user",
          actorId: String(ctx.user.id),
          action: "match.state_changed",
          resourceType: "match",
          resourceId: match.id,
          previousState: match.status,
          nextState: "closed",
          metadata: { reason: "candidate_deletion_cascade", candidateId: candidate.id },
        });
      }

      // 6. Cascade deletion to connected open placements
      const candidatePlacements = await db.select().from(placements).where(and(eq(placements.candidateId, candidate.id), eq(placements.ownerId, ctx.user.id)));
      for (const placement of candidatePlacements) {
        if (placement.status === "closed") continue;
        assertTransition("placement", placement.status, "closed");
        await db.update(placements).set({ status: "closed" }).where(eq(placements.id, placement.id));
        await recordAudit({
          ownerId: ctx.user.id,
          actorType: "user",
          actorId: String(ctx.user.id),
          action: "placement.state_changed",
          resourceType: "placement",
          resourceId: placement.id,
          previousState: placement.status,
          nextState: "closed",
          metadata: { reason: "candidate_deletion_cascade", candidateId: candidate.id },
        });
      }

      // 7. Withdraw any granted consents for privacy compliance
      await db.update(consents).set({ status: "withdrawn", withdrawnAt: new Date() }).where(and(eq(consents.ownerId, ctx.user.id), eq(consents.candidateId, candidate.id), eq(consents.status, "granted")));

      // 8. Insert suppressionList entries so future outreach cannot target the candidate's contacts
      const suppressionReason = input.resolutionNote || "privacy_deletion_erasure";
      if (emailHash) {
        await db.insert(suppressionList).values({
          id: createId("sup_"),
          ownerId: ctx.user.id,
          channel: "email",
          valueHash: emailHash,
          reason: suppressionReason,
          source: "candidate_rights",
          active: true,
        }).onDuplicateKeyUpdate({ set: { active: true, reason: suppressionReason } });
      }
      if (phoneHash) {
        await db.insert(suppressionList).values({
          id: createId("sup_"),
          ownerId: ctx.user.id,
          channel: "phone",
          valueHash: phoneHash,
          reason: suppressionReason,
          source: "candidate_rights",
          active: true,
        }).onDuplicateKeyUpdate({ set: { active: true, reason: suppressionReason } });
      }

      // 9. Verify and physically delete candidate documents first (fail-closed for statutory right-to-erasure)
      const docs = await db.select().from(candidateDocuments).where(and(eq(candidateDocuments.candidateId, candidate.id), eq(candidateDocuments.ownerId, ctx.user.id)));
      for (const doc of docs) {
        try {
          await deletePrivateDocument(doc.storageKey);
        } catch (err: any) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await recordAudit({
            ownerId: ctx.user.id,
            actorType: "user",
            actorId: String(ctx.user.id),
            action: "privacy.erasure_failed",
            resourceType: "candidate_document",
            resourceId: doc.id,
            previousState: doc.scanState,
            nextState: doc.scanState,
            metadata: {
              reason: "physical_storage_deletion_failure",
              candidateId: candidate.id,
              storageKey: doc.storageKey,
              error: errMsg,
            },
          });
          if (request.status !== "investigation") {
            assertTransition("rights_request", request.status, "investigation");
          }
          await db.update(rightsRequests).set({
            status: "investigation",
            details: `${request.details}\n[Failure] Physical deletion failure on document ${doc.id}: ${errMsg}`,
          }).where(eq(rightsRequests.id, request.id));
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Physical storage deletion failed for candidate document ${doc.id}: ${errMsg}. Statutory erasure cannot be completed.`,
          });
        }
      }

      // 10. Only after all physical deletions succeed, redact document records
      let documentsDeletedCount = 0;
      for (const doc of docs) {
        await db.update(candidateDocuments).set({
          storageKey: `deleted/${doc.id}`,
          storageUrl: "",
          originalName: "redacted.bin",
          parsedData: null,
          scanState: "redacted",
          parseState: "redacted",
        }).where(eq(candidateDocuments.id, doc.id));
        await recordAudit({
          ownerId: ctx.user.id,
          actorType: "user",
          actorId: String(ctx.user.id),
          action: "document.deleted",
          resourceType: "candidate_document",
          resourceId: doc.id,
          previousState: doc.scanState,
          nextState: "redacted",
          metadata: { reason: "candidate_privacy_erasure", candidateId: candidate.id },
        });
        documentsDeletedCount++;
      }

      // 10. Update candidate record with redacted PII and terminal deleted state
      await db.update(candidates).set({
        fullName: "Deleted candidate",
        email: null,
        emailHash: null,
        phone: null,
        phoneHash: null,
        headline: null,
        location: null,
        availability: null,
        profileState: "deleted",
        deletedAt: new Date(),
      }).where(and(eq(candidates.id, candidate.id), eq(candidates.ownerId, ctx.user.id)));

      // 11. Update rights request to resolved
      assertTransition("rights_request", request.status, "resolved");
      await db.update(rightsRequests).set({
        status: "resolved",
        resolvedAt: new Date(),
        details: `${request.details}\nResolution: ${input.resolutionNote}`,
      }).where(eq(rightsRequests.id, request.id));

      // 12. Record audit entries
      await recordAudit({
        ownerId: ctx.user.id,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "candidate.deleted",
        resourceType: "candidate",
        resourceId: candidate.id,
        previousState: candidate.profileState,
        nextState: "deleted",
        metadata: {
          requestId: request.id,
          piiRedacted: true,
          emailSuppressed: Boolean(emailHash),
          phoneSuppressed: Boolean(phoneHash),
          documentsDeletedCount,
          cascaded: {
            interviewsCount: candidateInterviews.length,
            shortlistsCount: candidateShortlists.length,
            matchesCount: candidateMatches.length,
            placementsCount: candidatePlacements.length,
          },
        },
      });

      await recordAudit({
        ownerId: ctx.user.id,
        actorType: "user",
        actorId: String(ctx.user.id),
        action: "privacy.deletion_fulfilled",
        resourceType: "rights_request",
        resourceId: request.id,
        previousState: "received",
        nextState: "resolved",
        metadata: { candidateId: candidate.id, piiRedacted: true },
      });

      return { success: true };
    }),
  }),
});
