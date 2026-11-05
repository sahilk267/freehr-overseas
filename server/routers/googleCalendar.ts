import { commonAvailability } from "../services/availability";
import { calendarAutomationStatus, configureCalendarAutomation } from "../services/calendarAutomation";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { reviewGoogleConflict, beginGoogleCalendar, configureGoogleCalendar, disconnectGoogleCalendar, googleCalendarStatus, googleFreeBusy, googleFreeBusyWithBuffers, previewGoogleInterview, syncGoogleInterview } from "../services/googleCalendar";
const owner = (ctx: { user: { id: number }; actor: { id: number }; res?: { setHeader?: (name: string, value: string) => unknown } }) => { ctx.res?.setHeader?.("Cache-Control", "private, no-store"); if (ctx.user.id !== ctx.actor.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage calendar connections." }); return ctx.user.id; };
export const googleCalendarRouter = router({
  proposeSlots: protectedProcedure.input(z.object({candidate:z.array(z.object({start:z.date(),end:z.date()})).min(1).max(100),interviewer:z.array(z.object({start:z.date(),end:z.date()})).min(1).max(100),durationMinutes:z.number().int().min(15).max(240),bufferMinutes:z.number().int().min(0).max(60).default(15)})).query(async({ctx,input})=>{
    const id=owner(ctx),initial=commonAvailability(input);
    if(!initial.slots.length)return {...initial,googleChecked:false};
    const start=new Date(Math.min(...input.candidate.map(w=>w.start.getTime()),...input.interviewer.map(w=>w.start.getTime()))),end=new Date(Math.max(...input.candidate.map(w=>w.end.getTime()),...input.interviewer.map(w=>w.end.getTime())));
    const busy=await googleFreeBusyWithBuffers(id,new Date(start.getTime()-input.bufferMinutes*60000),new Date(end.getTime()+input.bufferMinutes*60000));
    return {...commonAvailability({...input,busy:busy.busy}),googleChecked:true};
  }),
  automationStatus: protectedProcedure.query(({ctx})=>calendarAutomationStatus(owner(ctx))),
  configureAutomation: protectedProcedure.input(z.object({enabled:z.boolean(),expectedRevision:z.number().int().nonnegative()})).mutation(({ctx,input})=>configureCalendarAutomation(owner(ctx),ctx.actor.id,input.enabled,input.expectedRevision)),
  status: protectedProcedure.query(({ ctx }) => googleCalendarStatus(owner(ctx))),
  begin: protectedProcedure.mutation(({ ctx }) => beginGoogleCalendar(owner(ctx), ctx.req.headers.cookie)),
  disconnect: protectedProcedure.mutation(({ ctx }) => disconnectGoogleCalendar(owner(ctx))),
  configure: protectedProcedure.input(z.object({ calendarId: z.string().trim().min(1).max(320), expectedRevision: z.number().int().positive() })).mutation(({ ctx, input }) => configureGoogleCalendar(owner(ctx), input.calendarId, input.expectedRevision)),
  freeBusy: protectedProcedure.input(z.object({ start: z.date(), end: z.date() })).query(({ ctx, input }) => googleFreeBusy(owner(ctx), input.start, input.end)),
  preview: protectedProcedure.input(z.object({ interviewId: z.string().min(4).max(36) })).query(({ ctx, input }) => previewGoogleInterview(owner(ctx), input.interviewId)),
  reviewConflict: protectedProcedure.input(z.object({interviewId:z.string().min(4).max(36)})).query(({ctx,input})=>reviewGoogleConflict(owner(ctx),input.interviewId)),
  sync: protectedProcedure.input(z.object({ interviewId: z.string().min(4).max(36), previewHash: z.string().length(64), approvedExternalReviewHash:z.string().length(64).optional() })).mutation(({ ctx, input }) => syncGoogleInterview(owner(ctx), input.interviewId, input.previewHash, undefined, "manual", input.approvedExternalReviewHash)),
});
