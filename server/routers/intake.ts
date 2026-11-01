import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { intakeBatches } from "../../drizzle/schema";
import { intakeBatchInput } from "../../shared/intake";
import { requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { controlIntakeSource, createIntakeSource, importReviewedIntake, listIntakeSources, previewIntake, requireIntakeSource } from "../services/sourceIntake";

const sourceInput = z.object({ sourceId: z.string().min(4).max(36) });
export const intakeRouter = router({
  sources: router({
    list: protectedProcedure.query(({ ctx }) => listIntakeSources(ctx.user.id)),
    create: protectedProcedure.input(z.object({ requestKey: z.string().min(8).max(80), name: z.string().trim().min(3).max(160), kind: z.enum(["candidate", "prospect"]) })).mutation(({ ctx, input }) => createIntakeSource(ctx.user.id, ctx.actor.id, { name: input.name, kind: input.kind, requestKey: input.requestKey })),
    control: protectedProcedure.input(z.object({ id: z.string().min(4).max(36), expectedRevision: z.number().int().positive(), action: z.enum(["enable", "disable", "rotate_key"]) })).mutation(({ ctx, input }) => controlIntakeSource(ctx.user.id, ctx.actor.id, { id: input.id, expectedRevision: input.expectedRevision, action: input.action })),
  }),
  preview: protectedProcedure.input(sourceInput.extend({ batch: intakeBatchInput })).mutation(({ ctx, input }) => previewIntake(ctx.user.id, input.sourceId, input.batch)),
  importReviewed: protectedProcedure.input(sourceInput.extend({ batch: intakeBatchInput, previewHash: z.string().length(64) })).mutation(({ ctx, input }) => importReviewedIntake(ctx.user.id, input.sourceId, input.batch, input.previewHash)),
  batches: protectedProcedure.input(sourceInput).query(async ({ ctx, input }) => {
    const db = await requireDb(); await requireIntakeSource(db, ctx.user.id, input.sourceId);
    return db.select().from(intakeBatches).where(and(eq(intakeBatches.ownerId, ctx.user.id), eq(intakeBatches.sourceId, input.sourceId))).orderBy(desc(intakeBatches.createdAt)).limit(50);
  }),
});
