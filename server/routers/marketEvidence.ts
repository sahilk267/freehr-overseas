import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  marketPermissionSave,
  marketPreviewInput,
  marketCommitInput,
  marketReadQuery,
  marketRetire,
} from "../../shared/marketEvidence";
import {
  configureMarketPermission,
  marketPermissions,
  previewMarketBatch,
  recordMarketBatch,
  marketOverview,
  marketBatchHistory,
  marketSignalHistory,
  retireMarketSignal,
} from "../services/marketEvidence";
const headers = (ctx: any) => {
  ctx.res?.setHeader?.("Cache-Control", "private, no-store");
  ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
};
export const marketEvidenceRouter = router({
  permissions: protectedProcedure.query(({ ctx }) => {
    headers(ctx);
    return marketPermissions(ctx.user.id);
  }),
  configure: protectedProcedure
    .input(marketPermissionSave)
    .mutation(({ ctx, input }) => {
      headers(ctx);
      return configureMarketPermission(ctx.user.id, ctx.actor.id, input);
    }),
  preview: protectedProcedure
    .input(marketPreviewInput)
    .mutation(({ ctx, input }) => {
      headers(ctx);
      return previewMarketBatch(ctx.user.id, input.sourceId, input.batch);
    }),
  record: protectedProcedure
    .input(marketCommitInput)
    .mutation(({ ctx, input }) => {
      headers(ctx);
      return recordMarketBatch(
        ctx.user.id,
        input.sourceId,
        input.batch,
        input.previewHash
      );
    }),
  overview: protectedProcedure
    .input(marketReadQuery)
    .query(({ ctx, input }) => {
      headers(ctx);
      return marketOverview(ctx.user.id, input);
    }),
  batches: protectedProcedure.query(({ ctx }) => {
    headers(ctx);
    return marketBatchHistory(ctx.user.id);
  }),
  history: protectedProcedure
    .input(z.object({ id: z.string().min(4).max(64) }).strict())
    .query(({ ctx, input }) => {
      headers(ctx);
      return marketSignalHistory(ctx.user.id, input.id);
    }),
  retire: protectedProcedure.input(marketRetire).mutation(({ ctx, input }) => {
    headers(ctx);
    return retireMarketSignal(ctx.user.id, ctx.actor.id, input);
  }),
});
