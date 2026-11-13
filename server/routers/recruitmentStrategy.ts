import { router, protectedProcedure } from "../_core/trpc";
import {
  strategyFields,
  strategyDashboardQuery,
  strategySave,
  strategyRoleSave,
} from "../../shared/recruitmentStrategy";
import { modelRecruitmentStrategy } from "../services/strategyModel";
import {
  recruitmentStrategyDashboard,
  recruitmentStrategyHistory,
  saveRecruitmentStrategy,
  saveStrategyRole,
} from "../services/recruitmentStrategy";
const privateHeaders = (ctx: any) => {
  ctx.res?.setHeader?.("Cache-Control", "private, no-store");
  ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
};
export const recruitmentStrategyRouter = router({
  dashboard: protectedProcedure
    .input(strategyDashboardQuery)
    .query(({ ctx, input }) => {
      privateHeaders(ctx);
      return recruitmentStrategyDashboard(ctx.user.id, input);
    }),
  history: protectedProcedure.query(({ ctx }) => {
    privateHeaders(ctx);
    return recruitmentStrategyHistory(ctx.user.id);
  }),
  preview: protectedProcedure
    .input(strategyFields)
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return modelRecruitmentStrategy(input);
    }),
  save: protectedProcedure.input(strategySave).mutation(({ ctx, input }) => {
    privateHeaders(ctx);
    return saveRecruitmentStrategy(ctx.user.id, ctx.actor.id, input);
  }),
  assessRole: protectedProcedure
    .input(strategyRoleSave)
    .mutation(({ ctx, input }) => {
      privateHeaders(ctx);
      return saveStrategyRole(ctx.user.id, ctx.actor.id, input);
    }),
});
