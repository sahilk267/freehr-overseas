import {z} from 'zod';
import {publicProcedure,protectedProcedure,router} from '../_core/trpc';
import {createInterviewConfirmations,listInterviewConfirmations,publicInterviewConfirmation,revokeInterviewConfirmations} from '../services/interviewConfirmations';
const id=z.string().min(4).max(36),capability=z.object({id,token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
function noStore(ctx:any){ctx.res?.setHeader?.('Cache-Control','private, no-store');ctx.res?.setHeader?.('Referrer-Policy','no-referrer');}
export const interviewConfirmationsRouter=router({
 list:protectedProcedure.input(z.object({interviewId:id})).query(({ctx,input})=>{noStore(ctx);return listInterviewConfirmations(ctx.user.id,input.interviewId);}),
 create:protectedProcedure.input(z.object({interviewId:id,requestKey:z.string().min(8).max(100),expiresHours:z.number().int().min(1).max(168).default(48)})).mutation(({ctx,input})=>{noStore(ctx);return createInterviewConfirmations(ctx.user.id,ctx.actor.id,input);}),
 revoke:protectedProcedure.input(z.object({groupId:id})).mutation(({ctx,input})=>{noStore(ctx);return revokeInterviewConfirmations(ctx.user.id,ctx.actor.id,input.groupId);}),
 read:publicProcedure.input(capability).mutation(({ctx,input})=>{noStore(ctx);return publicInterviewConfirmation(input);}),
 respond:publicProcedure.input(capability.extend({decision:z.enum(['confirmed','declined'])})).mutation(({ctx,input})=>{noStore(ctx);return publicInterviewConfirmation(input);}),
});
