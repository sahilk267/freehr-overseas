import {z} from 'zod';
import {protectedProcedure,router} from '../_core/trpc';
import {ensurePlacementConversations,configurePlacementLifecycle,lifecyclePlanInput,placementLifecycleDetail,placementLifecycleOptions,preparePlacementCheckpoint,recordPlacementCheckpoint,checkpointResponseInput,recordPlacementDeparture,departureInput} from '../services/placementLifecycle';
const id=z.object({id:z.string().min(4).max(36)});
export const placementLifecycleRouter=router({
 prepareConversations:protectedProcedure.input(id).mutation(({ctx,input})=>ensurePlacementConversations(ctx.user.id,ctx.actor.id,input.id)),
 detail:protectedProcedure.input(id).query(({ctx,input})=>placementLifecycleDetail(ctx.user.id,input.id)),
 options:protectedProcedure.input(id).query(({ctx,input})=>placementLifecycleOptions(ctx.user.id,input.id)),
 configure:protectedProcedure.input(lifecyclePlanInput).mutation(({ctx,input})=>configurePlacementLifecycle(ctx.user.id,ctx.actor.id,input)),
 prepare:protectedProcedure.input(id).mutation(({ctx,input})=>preparePlacementCheckpoint(ctx.user.id,ctx.actor.id,input.id)),
 recordResponse:protectedProcedure.input(checkpointResponseInput).mutation(({ctx,input})=>recordPlacementCheckpoint(ctx.user.id,ctx.actor.id,input)),
 recordDeparture:protectedProcedure.input(departureInput).mutation(({ctx,input})=>recordPlacementDeparture(ctx.user.id,ctx.actor.id,input)),
});
