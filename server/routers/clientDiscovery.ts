import {availabilityMailOptions,prepareAvailabilityEmail} from "../services/availabilityMail";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { bookDiscovery, cancelDiscovery, createDiscoveryRequest, discoveryIcs, getDiscoveryRequest, listDiscoveryRequests, proposeDiscovery, publicDiscovery } from "../services/clientDiscovery";
const id=z.string().min(4).max(36),window=z.object({start:z.date(),end:z.date()}),capability=z.object({id,token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
function headers(ctx:any){ctx.res?.setHeader?.("Cache-Control","private, no-store");ctx.res?.setHeader?.("Referrer-Policy","no-referrer");}
function owner(ctx:any){headers(ctx);if(ctx.actor.id!==ctx.user.id)throw new TRPCError({code:"FORBIDDEN",message:"Only the owner can authorize client discovery booking."});return ctx.user.id;}
export const clientDiscoveryRouter=router({
 mailOptions:protectedProcedure.input(z.object({requestId:id})).query(({ctx,input})=>availabilityMailOptions(owner(ctx),input.requestId,"client_discovery")),
 prepareEmail:protectedProcedure.input(z.object({requestId:id,senderIdentityId:id})).mutation(async({ctx,input})=>{const ownerId=owner(ctx),r=await getDiscoveryRequest(ownerId,input.requestId);return prepareAvailabilityEmail(ownerId,ctx.actor.id,{inviteId:r.id,conversationId:r.conversationId,senderIdentityId:input.senderIdentityId},"client_discovery");}),
 create:protectedProcedure.input(z.object({conversationId:id,replyRevision:z.number().int().positive(),actionRevision:z.number().int().positive(),requestKey:z.string().min(8).max(100),ownerWindows:z.array(window).min(1).max(20),timezone:z.string().min(2).max(64),durationMinutes:z.number().int().min(15).max(120),bufferMinutes:z.number().int().min(0).max(60).default(15),expiresHours:z.number().int().min(1).max(168).default(48),autoSelect:z.boolean().default(false)})).mutation(({ctx,input})=>createDiscoveryRequest(owner(ctx),ctx.actor.id,input)),
 get:protectedProcedure.input(z.object({requestId:id})).query(({ctx,input})=>getDiscoveryRequest(owner(ctx),input.requestId)),
 list:protectedProcedure.input(z.object({conversationId:id})).query(({ctx,input})=>listDiscoveryRequests(owner(ctx),input.conversationId)),
 propose:protectedProcedure.input(z.object({requestId:id})).query(({ctx,input})=>proposeDiscovery(owner(ctx),input.requestId)),
 book:protectedProcedure.input(z.object({requestId:id,scheduledAt:z.date(),fingerprint:z.string().length(64)})).mutation(({ctx,input})=>bookDiscovery(owner(ctx),ctx.actor.id,input)),
 cancel:protectedProcedure.input(z.object({requestId:id,expectedRevision:z.number().int().positive()})).mutation(({ctx,input})=>cancelDiscovery(owner(ctx),ctx.actor.id,input)),
 ics:protectedProcedure.input(z.object({meetingId:id})).query(({ctx,input})=>discoveryIcs(owner(ctx),input.meetingId)),
 read:publicProcedure.input(capability).mutation(({ctx,input})=>{headers(ctx);return publicDiscovery(input);}),
 respond:publicProcedure.input(capability.extend({expectedRevision:z.number().int().positive(),timezone:z.string().min(2).max(64),windows:z.array(window).min(1).max(20)})).mutation(({ctx,input})=>{headers(ctx);return publicDiscovery(input);}),
});
