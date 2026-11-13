import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { ownerBriefConfigure, ownerBriefQuery } from "../../shared/ownerBrief";
import {
  configureOwnerBrief,
  getOwnerBriefSettings,
  ownerOverview,
  recordOwnerBrief,
  ownerBriefHistory,
  scheduleOwnerBrief,
} from "../services/ownerBrief";
const noStore = (ctx: any) => {
  ctx.res?.setHeader?.("Cache-Control", "private, no-store");
  ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
};
export const ownerBriefRouter = router({
  settings: protectedProcedure.query(({ ctx }) => {
    noStore(ctx);
    return getOwnerBriefSettings(ctx.user.id);
  }),
  configure: protectedProcedure
    .input(ownerBriefConfigure)
    .mutation(({ ctx, input }) => {
      noStore(ctx);
      return configureOwnerBrief(ctx.user.id, ctx.actor.id, input);
    }),
  overview: protectedProcedure
    .input(ownerBriefQuery)
    .query(({ ctx, input }) => {
      noStore(ctx);
      return ownerOverview(ctx.user.id, input);
    }),
  record: protectedProcedure
    .input(z.object({ requestKey: z.string().min(8).max(100) }))
    .mutation(({ ctx, input }) => {
      noStore(ctx);
      return recordOwnerBrief(ctx.user.id, ctx.actor.id, input.requestKey);
    }),
  history: protectedProcedure.query(({ ctx }) => {
    noStore(ctx);
    return ownerBriefHistory(ctx.user.id);
  }),
  schedule: protectedProcedure.mutation(({ ctx }) => {
    noStore(ctx);
    return scheduleOwnerBrief(ctx.user.id);
  }),
});
