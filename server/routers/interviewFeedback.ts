import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  feedbackPanelInput,
  structuredFeedbackInput,
  resolveFeedbackInput,
} from "../../shared/interviewFeedback";
import {
  ensureInterviewFeedbackConversation,
  configureInterviewFeedback,
  recordStructuredInterviewFeedback,
  resolveInterviewFeedback,
  interviewFeedbackDetail,
  enrollInterviewFeedbackReminder,
} from "../services/interviewFeedback";
const id = z.string().min(4).max(36);
export const interviewFeedbackRouter = router({
  ensureConversation: protectedProcedure
    .input(
      z
        .object({ interviewId: id, reviewerKey: z.string().min(2).max(40) })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ensureInterviewFeedbackConversation(ctx.user.id, ctx.actor.id, input)
    ),
  detail: protectedProcedure
    .input(z.object({ interviewId: id }).strict())
    .query(({ ctx, input }) => {
      ctx.res?.setHeader?.("Cache-Control", "private, no-store");
      ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
      return interviewFeedbackDetail(ctx.user.id, input.interviewId);
    }),
  configure: protectedProcedure
    .input(feedbackPanelInput)
    .mutation(({ ctx, input }) =>
      configureInterviewFeedback(ctx.user.id, ctx.actor.id, input)
    ),
  record: protectedProcedure
    .input(structuredFeedbackInput)
    .mutation(({ ctx, input }) =>
      recordStructuredInterviewFeedback(ctx.user.id, ctx.actor.id, input)
    ),
  resolve: protectedProcedure
    .input(resolveFeedbackInput)
    .mutation(({ ctx, input }) =>
      resolveInterviewFeedback(ctx.user.id, ctx.actor.id, input)
    ),
  enrollReminder: protectedProcedure
    .input(
      z
        .object({
          interviewId: id,
          reviewerKey: z.string().min(2).max(40),
          conversationId: id,
          senderIdentityId: id,
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      enrollInterviewFeedbackReminder(ctx.user.id, ctx.actor.id, input)
    ),
});
