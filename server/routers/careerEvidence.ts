import {
  recordCareerSource,
  recordCareerSourceInput,
} from "../services/careerSource";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getCareerEvidence,
  reviewCareerEvidence,
  reviewCareerEvidenceInput,
} from "../services/careerEvidence";
export const careerEvidenceRouter = router({
  recordSource: protectedProcedure
    .input(recordCareerSourceInput)
    .mutation(({ ctx, input }) =>
      recordCareerSource(ctx.user.id, ctx.actor.id, input)
    ),
  detail: protectedProcedure
    .input(z.object({ candidateId: z.string().min(4).max(36) }).strict())
    .query(({ ctx, input }) => {
      ctx.res?.setHeader?.("Cache-Control", "private, no-store");
      return getCareerEvidence(ctx.user.id, input.candidateId);
    }),
  review: protectedProcedure
    .input(reviewCareerEvidenceInput)
    .mutation(({ ctx, input }) =>
      reviewCareerEvidence(ctx.user.id, ctx.actor.id, input)
    ),
});
