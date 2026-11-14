import { protectedProcedure, router } from "../_core/trpc";
import { policyLabQuery, policySimulation } from "../../shared/policyLab";
import { policyLabCatalog, simulatePolicy } from "../services/policyLab";
const headers = (ctx: any) => {
  ctx.res?.setHeader?.("Cache-Control", "private, no-store");
  ctx.res?.setHeader?.("Referrer-Policy", "no-referrer");
};
export const policyLabRouter = router({
  catalog: protectedProcedure.input(policyLabQuery).query(({ ctx, input }) => {
    headers(ctx);
    return policyLabCatalog(ctx.user.id, input);
  }),
  simulate: protectedProcedure
    .input(policySimulation)
    .mutation(({ ctx, input }) => {
      headers(ctx);
      return simulatePolicy(ctx.user.id, input);
    }),
});
