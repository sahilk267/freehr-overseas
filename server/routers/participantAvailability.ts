import {z} from 'zod';
import {publicProcedure,protectedProcedure,router} from '../_core/trpc';
import {createAvailabilityInvites,listAvailabilityInvites,proposeCollectedAvailability,publicAvailability,revokeAvailability} from '../services/participantAvailability';
const capability=z.object({id:z.string().min(4).max(36),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
const group=z.object({groupId:z.string().min(4).max(36)});
function noStore(ctx:any){ctx.res?.setHeader?.('Cache-Control','private, no-store');ctx.res?.setHeader?.('Referrer-Policy','no-referrer');}
export const participantAvailabilityRouter=router({
 list:protectedProcedure.query(({ctx})=>{noStore(ctx);return listAvailabilityInvites(ctx.user.id);}),
 create:protectedProcedure.input(z.object({candidateId:z.string().min(4).max(36),jobId:z.string().min(4).max(36),requestKey:z.string().min(8).max(100),expiresHours:z.number().int().min(1).max(168).default(48)})).mutation(({ctx,input})=>{noStore(ctx);return createAvailabilityInvites(ctx.user.id,ctx.actor.id,input);}),
 revoke:protectedProcedure.input(group).mutation(({ctx,input})=>revokeAvailability(ctx.user.id,ctx.actor.id,input.groupId)),
 propose:protectedProcedure.input(group.extend({durationMinutes:z.number().int().min(15).max(240),bufferMinutes:z.number().int().min(0).max(60).default(15)})).query(({ctx,input})=>{noStore(ctx);return proposeCollectedAvailability(ctx.user.id,input.groupId,input.durationMinutes,input.bufferMinutes);}),
 read:publicProcedure.input(capability).mutation(({ctx,input})=>{noStore(ctx);return publicAvailability(input);}),
 respond:publicProcedure.input(capability.extend({expectedRevision:z.number().int().positive(),timezone:z.string().min(2).max(64),windows:z.array(z.object({start:z.date(),end:z.date()})).min(1).max(20)})).mutation(({ctx,input})=>{noStore(ctx);return publicAvailability(input);}),
});
