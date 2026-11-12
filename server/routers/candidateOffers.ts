import {z} from 'zod';
import {protectedProcedure,publicProcedure,router} from '../_core/trpc';
import {offerCapability,offerSessionCapability,offerReplySchema} from '../../shared/candidateOffer';
import {prepareOfferCounterDraft,offerAuthorityInput,offerDraftInput,releaseOfferInput,recordOfferAuthority,saveOfferDraft,requestOfferRelease,revealOfferLink,offerOwnerDetail,publicOfferEntry,requestOfferOtp,verifyOfferOtp,readAuthenticatedOffer,recordCandidateOfferReply,reportCandidateOfferWithdrawal,reviewOfferCondition,closeCandidateOffer,enrollOfferFollowup,recordOfferLinkShared} from '../services/candidateOffers';
import {prepareOfferLinkEmail} from '../services/candidateOfferMail';
import {generateCandidateOfferDocument} from '../services/candidateOfferDocument';
const id=z.string().min(4).max(36),reason=z.string().trim().min(8).max(2000),noStore=(ctx:any)=>{ctx.res?.setHeader?.('Cache-Control','private, no-store');ctx.res?.setHeader?.('Referrer-Policy','no-referrer');};
export const candidateOffersRouter=router({
 prepareCounterDraft:protectedProcedure.input(z.object({id,reason})).mutation(({ctx,input})=>prepareOfferCounterDraft(ctx.user.id,ctx.actor.id,input)),
 detail:protectedProcedure.input(z.object({placementId:id})).query(({ctx,input})=>{noStore(ctx);return offerOwnerDetail(ctx.user.id,input.placementId);}),
 recordAuthority:protectedProcedure.input(offerAuthorityInput).mutation(({ctx,input})=>recordOfferAuthority(ctx.user.id,ctx.actor.id,input)),
 saveDraft:protectedProcedure.input(offerDraftInput).mutation(({ctx,input})=>saveOfferDraft(ctx.user.id,ctx.actor.id,input)),
 requestRelease:protectedProcedure.input(releaseOfferInput).mutation(({ctx,input})=>requestOfferRelease(ctx.user.id,ctx.actor.id,input)),
 revealLink:protectedProcedure.input(z.object({id})).mutation(({ctx,input})=>{noStore(ctx);return revealOfferLink(ctx.user.id,ctx.actor.id,input.id);}),
 prepareEmail:protectedProcedure.input(z.object({id})).mutation(({ctx,input})=>prepareOfferLinkEmail(ctx.user.id,ctx.actor.id,input.id)),
 recordShared:protectedProcedure.input(z.object({id,evidence:reason})).mutation(({ctx,input})=>recordOfferLinkShared(ctx.user.id,ctx.actor.id,input)),
 enrollFollowup:protectedProcedure.input(z.object({id})).mutation(({ctx,input})=>enrollOfferFollowup(ctx.user.id,ctx.actor.id,input.id)),
 close:protectedProcedure.input(z.object({id,version:z.number().int().positive(),reason})).mutation(({ctx,input})=>closeCandidateOffer(ctx.user.id,ctx.actor.id,input)),
 reviewCondition:protectedProcedure.input(z.object({id,version:z.number().int().positive(),termsHash:z.string().length(64),conditionId:z.string().min(2).max(48),evidence:reason,state:z.enum(['complete','blocked']).default('complete'),issuer:z.string().trim().min(2).max(200).optional(),reference:z.string().trim().min(2).max(500).optional(),validUntil:z.date().optional()})).mutation(({ctx,input})=>reviewOfferCondition(ctx.user.id,ctx.actor.id,input)),
 document:protectedProcedure.input(z.object({id,version:z.number().int().positive().optional()})).query(({ctx,input})=>{noStore(ctx);return generateCandidateOfferDocument(ctx.user.id,input.id,input.version);}),
 entry:publicProcedure.input(offerCapability).mutation(({ctx,input})=>{noStore(ctx);return publicOfferEntry(input);}),
 requestCode:publicProcedure.input(offerCapability.extend({resend:z.boolean().optional()}).strict()).mutation(({ctx,input})=>{noStore(ctx);return requestOfferOtp(input);}),
 verifyCode:publicProcedure.input(offerCapability.extend({challengeId:id,code:z.string().regex(/^\d{6}$/)}).strict()).mutation(({ctx,input})=>{noStore(ctx);return verifyOfferOtp(input);}),
 read:publicProcedure.input(offerSessionCapability).mutation(({ctx,input})=>{noStore(ctx);return readAuthenticatedOffer(input);}),
 respond:publicProcedure.input(offerReplySchema).mutation(({ctx,input})=>{noStore(ctx);return recordCandidateOfferReply(input);}),
 reportWithdrawal:publicProcedure.input(offerSessionCapability.extend({reason,acknowledged:z.literal(true)}).strict()).mutation(({ctx,input})=>{noStore(ctx);return reportCandidateOfferWithdrawal(input);}),
});
