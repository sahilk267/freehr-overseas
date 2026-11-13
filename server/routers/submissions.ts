import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  prepareSubmissionInput,
  submissionCapability,
  submissionFeedback,
  submissionSession,
} from "../../shared/submission";
import {
  prepareSubmission,
  releaseSubmission,
  prepareSubmissionMail,
  publicSubmissionEntry,
  requestSubmissionOtp,
  verifySubmissionOtp,
  readSubmission,
  respondSubmission,
  revokeSubmission,
  submissionDetail,
  enrollSubmissionFollowup,
  submissionOptions,
} from "../services/submissions";
import { requireDb } from "../db";
import { shortlists } from "../../drizzle/schema";
import { and, desc, eq } from "drizzle-orm";
const id = z.string().min(4).max(36),
  privateHeaders = (ctx: any) => {
    ctx.res?.setHeader?.("Cache-Control", "private, no-store");
    ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
  };
export const submissionsRouter = router({
  list: protectedProcedure
    .input(z.object({ candidateId: id.optional(), jobId: id.optional() }))
    .query(async ({ ctx, input }) => {
      privateHeaders(ctx);
      const db = await requireDb();
      return db
        .select()
        .from(shortlists)
        .where(
          and(
            eq(shortlists.ownerId, ctx.user.id),
            ...(input.candidateId
              ? [eq(shortlists.candidateId, input.candidateId)]
              : []),
            ...(input.jobId ? [eq(shortlists.jobId, input.jobId)] : [])
          )
        )
        .orderBy(desc(shortlists.createdAt), desc(shortlists.id))
        .limit(101)
        .then((rows: any[]) => ({
          rows: rows.slice(0, 100),
          more: rows.length > 100,
        }));
    }),
  options: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["candidate", "job", "contact", "sender"]),
        search: z.string().trim().max(80).optional(),
        jobId: id.optional(),
      })
    )
    .query(({ ctx, input }) => {
      privateHeaders(ctx);
      return submissionOptions(ctx.user.id, input);
    }),
  prepare: protectedProcedure
    .input(prepareSubmissionInput)
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return prepareSubmission(ctx.user.id, ctx.actor.id, input);
    }),
  detail: protectedProcedure.input(z.object({ id })).query(({ ctx, input }) => {
    privateHeaders(ctx);
    return submissionDetail(ctx.user.id, input.id);
  }),
  release: protectedProcedure
    .input(z.object({ id, version: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return releaseSubmission(
        ctx.user.id,
        ctx.actor.id,
        input.id,
        input.version
      );
    }),
  prepareEmail: protectedProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return prepareSubmissionMail(ctx.user.id, input.id);
    }),
  enrollFollowup: protectedProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return enrollSubmissionFollowup(ctx.user.id, input.id);
    }),
  revoke: protectedProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return revokeSubmission(ctx.user.id, ctx.actor.id, input.id);
    }),
  entry: publicProcedure
    .input(submissionCapability)
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return publicSubmissionEntry(input);
    }),
  requestCode: publicProcedure
    .input(
      submissionCapability.extend({ resend: z.boolean().optional() }).strict()
    )
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return requestSubmissionOtp(input);
    }),
  verifyCode: publicProcedure
    .input(
      submissionCapability
        .extend({ challengeId: id, code: z.string().max(20) })
        .strict()
    )
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return verifySubmissionOtp(input);
    }),
  read: publicProcedure.input(submissionSession).mutation(({ ctx, input }) => {
    privateHeaders(ctx);
    return readSubmission(input);
  }),
  respond: publicProcedure
    .input(submissionFeedback)
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return respondSubmission(input);
    }),
});
