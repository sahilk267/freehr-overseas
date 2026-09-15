import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { operationsRouter } from "./routers/operations";
import { recruitmentRouter } from "./routers/recruitment";
import { emailRouter } from "./routers/email";
import { teamRouter } from "./routers/team";
import { getRuntimeLogoutCookie } from "./services/runtimeAuth";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const oidcLogoutCookie = getRuntimeLogoutCookie();
      const response = ctx.res as unknown as { clearCookie?: (name: string, options: Record<string, unknown>) => void; append?: (name: string, value: string) => void; setHeader?: (name: string, value: string) => void };
      if (oidcLogoutCookie) {
        if (response.append) response.append("Set-Cookie", oidcLogoutCookie);
        else response.setHeader?.("Set-Cookie", oidcLogoutCookie);
      } else {
        const cookieOptions = getSessionCookieOptions(ctx.req);
        if (response.clearCookie) response.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
        else response.setHeader?.("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
      }
      return {
        success: true,
      } as const;
    }),
  }),

  recruitment: recruitmentRouter,
  operations: operationsRouter,
  email: emailRouter,
  team: teamRouter,

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
