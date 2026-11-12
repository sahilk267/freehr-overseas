import { protectedProcedure, router } from "../_core/trpc";
import { analyticsInput } from "../../shared/analytics";
import {
  getAnalyticsReport,
  exportAnalyticsReport,
  analyticsExportInput,
  analyticsScopeOptions,
  analyticsOptionsInput,
} from "../services/analytics";
export const analyticsRouter = router({
  options: protectedProcedure
    .input(analyticsOptionsInput)
    .query(({ ctx, input }) => {
      ctx.res?.setHeader?.("Cache-Control", "private, no-store");
      return analyticsScopeOptions(ctx.user.id, input);
    }),
  report: protectedProcedure.input(analyticsInput).query(({ ctx, input }) => {
    ctx.res?.setHeader?.("Cache-Control", "private, no-store");
    ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
    return getAnalyticsReport(ctx.user.id, input);
  }),
  export: protectedProcedure
    .input(analyticsExportInput)
    .mutation(({ ctx, input }) => {
      ctx.res?.setHeader?.("Cache-Control", "private, no-store");
      return exportAnalyticsReport(ctx.user.id, input);
    }),
});
