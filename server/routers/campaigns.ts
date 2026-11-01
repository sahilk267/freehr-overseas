import { campaignInput } from "../validators/campaigns";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { outreachCampaigns, outreachCampaignRecipients } from "../../drizzle/schema";
import { CAMPAIGN_SCENARIOS } from "../../shared/campaigns";
import { requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { createCampaign, previewCampaign, launchCampaign, controlCampaign, processDueCampaigns } from "../services/campaigns";

const idInput = z.object({ id: z.string().min(4).max(36) });
export const campaignsRouter = router({
  catalog: protectedProcedure.query(() => CAMPAIGN_SCENARIOS),
  list: protectedProcedure.query(async ({ ctx }) => (await requireDb()).select().from(outreachCampaigns).where(eq(outreachCampaigns.ownerId, ctx.user.id)).orderBy(desc(outreachCampaigns.updatedAt)).limit(100)),
  detail: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const campaign = (await db.select().from(outreachCampaigns).where(and(eq(outreachCampaigns.id, input.id), eq(outreachCampaigns.ownerId, ctx.user.id))).limit(1))[0];
    if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign was not found." });
    const recipients = await db.select().from(outreachCampaignRecipients).where(and(eq(outreachCampaignRecipients.ownerId, ctx.user.id), eq(outreachCampaignRecipients.campaignId, campaign.id))).limit(100);
    return { campaign, recipients };
  }),
  draft: protectedProcedure.input(campaignInput).mutation(({ ctx, input }) => createCampaign(ctx.user.id, ctx.actor.id, input)),
  preview: protectedProcedure.input(idInput).query(({ ctx, input }) => previewCampaign(ctx.user.id, input.id)),
  launch: protectedProcedure.input(idInput.extend({ expectedRevision: z.number().int().positive(), previewHash: z.string().length(64), authorizeSending: z.boolean() })).mutation(({ ctx, input }) => launchCampaign(ctx.user.id, ctx.actor.id, { id: input.id, expectedRevision: input.expectedRevision, previewHash: input.previewHash, authorizeSending: input.authorizeSending })),
  control: protectedProcedure.input(idInput.extend({ expectedRevision: z.number().int().positive(), action: z.enum(["pause", "resume_review", "cancel"]) })).mutation(({ ctx, input }) => controlCampaign(ctx.user.id, ctx.actor.id, { id: input.id, expectedRevision: input.expectedRevision, action: input.action })),
  processDue: protectedProcedure.mutation(({ ctx }) => processDueCampaigns(ctx.user.id, 25)),
});
