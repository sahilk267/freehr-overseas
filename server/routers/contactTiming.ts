import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { contactTimingSave } from "../../shared/contactTiming";
import {
  readContactTiming,
  saveContactTiming,
  retireContactTiming,
} from "../services/contactTiming";
const id = z.string().min(4).max(36),
  noStore = (ctx: any) => {
    ctx.res?.setHeader?.("Cache-Control", "private, no-store");
    ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
  };
export const contactTimingRouter = router({
  read: protectedProcedure
    .input(z.object({ planId: id }))
    .query(({ ctx, input }) => {
      noStore(ctx);
      return readContactTiming(ctx.user.id, input.planId);
    }),
  save: protectedProcedure
    .input(contactTimingSave)
    .mutation(({ ctx, input }) => {
      noStore(ctx);
      return saveContactTiming(ctx.user.id, ctx.actor.id, input);
    }),
  retire: protectedProcedure
    .input(
      z.object({
        planId: id,
        expectedRevision: z.number().int().nonnegative(),
        reason: z.string().trim().min(8).max(2000),
      })
    )
    .mutation(({ ctx, input }) => {
      noStore(ctx);
      return retireContactTiming(ctx.user.id, ctx.actor.id, input);
    }),
});
