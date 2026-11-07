import {withWorkspaceTransaction} from '../services/database';
import {reviewRequest} from '../services/candidateReviewState';
import {ensureCandidateReviewConversation,candidateReviewFollowupInput,candidateReviewHistory,clarifyCandidateReview,clarifyCandidateReviewInput,completeCandidateReview,enrollCandidateReviewFollowup} from '../services/candidateReviewOperations';
import {z} from 'zod';
import {protectedProcedure,publicProcedure,router} from '../_core/trpc';
import {candidateReviewCapability,candidateReviewFields,candidateReviewResponseSchema} from '../../shared/candidateReview';
import {createCandidateReview,listCandidateReviews,publicCandidateReview,respondCandidateReview,revokeCandidateReview,adoptCandidateReview} from '../services/candidateReview';
import {availabilityMailOptions,prepareAvailabilityEmail} from '../services/availabilityMail';
const id=z.string().min(4).max(36);
const noStore=(ctx:any)=>{ctx.res?.setHeader?.('Cache-Control','private, no-store');ctx.res?.setHeader?.('Referrer-Policy','no-referrer');};
export const candidateReviewsRouter=router({
 ensureConversation:protectedProcedure.input(z.object({id})).mutation(({ctx,input})=>{noStore(ctx);return ensureCandidateReviewConversation(ctx.user.id,ctx.actor.id,input.id);}),
 locate:protectedProcedure.input(z.object({id})).query(({ctx,input})=>{noStore(ctx);return withWorkspaceTransaction(ctx.user.id,async tx=>({candidateId:String((await reviewRequest(tx,ctx.user.id,input.id)).metadata.candidateId)}));}),
 history:protectedProcedure.input(z.object({id})).query(({ctx,input})=>{noStore(ctx);return candidateReviewHistory(ctx.user.id,input.id);}),
 clarify:protectedProcedure.input(clarifyCandidateReviewInput).mutation(({ctx,input})=>{noStore(ctx);return clarifyCandidateReview(ctx.user.id,ctx.actor.id,input);}),
 complete:protectedProcedure.input(z.object({id,responseRevision:z.number().int().positive(),reason:z.string().trim().min(8).max(2000)}).strict()).mutation(({ctx,input})=>{noStore(ctx);return completeCandidateReview(ctx.user.id,ctx.actor.id,input);}),
 enrollFollowup:protectedProcedure.input(candidateReviewFollowupInput).mutation(({ctx,input})=>{noStore(ctx);return enrollCandidateReviewFollowup(ctx.user.id,ctx.actor.id,input);}),
 create:protectedProcedure.input(z.object({candidateId:id,jobId:id,requestKey:z.string().min(8).max(100),expiresHours:z.number().int().min(1).max(168).default(48)})).mutation(({ctx,input})=>{noStore(ctx);return createCandidateReview(ctx.user.id,ctx.actor.id,input);}),
 list:protectedProcedure.input(z.object({candidateId:id,reviewId:id.optional()})).query(({ctx,input})=>{noStore(ctx);return listCandidateReviews(ctx.user.id,input.candidateId,input.reviewId);}),
 revoke:protectedProcedure.input(z.object({id})).mutation(({ctx,input})=>{noStore(ctx);return revokeCandidateReview(ctx.user.id,ctx.actor.id,input.id);}),
 adopt:protectedProcedure.input(z.object({id,responseRevision:z.number().int().positive(),selectedFields:z.array(z.enum(candidateReviewFields)).min(1).max(7),reason:z.string().trim().min(8).max(2000)})).mutation(({ctx,input})=>{noStore(ctx);return adoptCandidateReview(ctx.user.id,ctx.actor.id,input);}),
 mailOptions:protectedProcedure.input(z.object({inviteId:id})).query(({ctx,input})=>{noStore(ctx);return availabilityMailOptions(ctx.user.id,input.inviteId,'candidate_evidence');}),
 prepareEmail:protectedProcedure.input(z.object({inviteId:id,conversationId:id,senderIdentityId:id})).mutation(({ctx,input})=>{noStore(ctx);return prepareAvailabilityEmail(ctx.user.id,ctx.actor.id,input,'candidate_evidence');}),
 read:publicProcedure.input(candidateReviewCapability).mutation(({ctx,input})=>{noStore(ctx);return publicCandidateReview(input);}),
 respond:publicProcedure.input(candidateReviewResponseSchema).mutation(({ctx,input})=>{noStore(ctx);return respondCandidateReview(input);}),
});
