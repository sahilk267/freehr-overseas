import { calendarAutomationStatus, configureCalendarAutomation } from "../services/calendarAutomation";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { beginGoogleCalendar, configureGoogleCalendar, disconnectGoogleCalendar, googleCalendarStatus, googleFreeBusy, previewGoogleInterview, syncGoogleInterview } from "../services/googleCalendar";
const owner = (ctx: { user: { id: number }; actor: { id: number }; res?: { setHeader?: (name: string, value: string) => unknown } }) => { ctx.res?.setHeader?.("Cache-Control", "private, no-store"); if (ctx.user.id !== ctx.actor.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage calendar connections." }); return ctx.user.id; };
export const googleCalendarRouter = router({
  automationStatus: protectedProcedure.query(({ctx})=>calendarAutomationStatus(owner(ctx))),
  configureAutomation: protectedProcedure.input(z.object({enabled:z.boolean(),expectedRevision:z.number().int().nonnegative()})).mutation(({ctx,input})=>configureCalendarAutomation(owner(ctx),ctx.actor.id,input.enabled,input.expectedRevision)),
  status: protectedProcedure.query(({ ctx }) => googleCalendarStatus(owner(ctx))),
  begin: protectedProcedure.mutation(({ ctx }) => beginGoogleCalendar(owner(ctx), ctx.req.headers.cookie)),
  disconnect: protectedProcedure.mutation(({ ctx }) => disconnectGoogleCalendar(owner(ctx))),
  configure: protectedProcedure.input(z.object({ calendarId: z.string().trim().min(1).max(320), expectedRevision: z.number().int().positive() })).mutation(({ ctx, input }) => configureGoogleCalendar(owner(ctx), input.calendarId, input.expectedRevision)),
  freeBusy: protectedProcedure.input(z.object({ start: z.date(), end: z.date() })).query(({ ctx, input }) => googleFreeBusy(owner(ctx), input.start, input.end)),
  preview: protectedProcedure.input(z.object({ interviewId: z.string().min(4).max(36) })).query(({ ctx, input }) => previewGoogleInterview(owner(ctx), input.interviewId)),
  sync: protectedProcedure.input(z.object({ interviewId: z.string().min(4).max(36), previewHash: z.string().length(64) })).mutation(({ ctx, input }) => syncGoogleInterview(owner(ctx), input.interviewId, input.previewHash)),
});
