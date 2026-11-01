import { z } from "zod";

export const campaignInput = z.object({
  requestKey: z.string().trim().min(8).max(80),
  name: z.string().trim().min(3).max(160),
  scenarioId: z.enum(["FU01", "FU28", "FU09", "FU29"]),
  senderIdentityId: z.string().min(4).max(36),
  recipientIds: z.array(z.string().min(4).max(36)).min(1).max(100),
  timezone: z.string().min(2).max(64),
  businessDaysOnly: z.boolean().default(true),
  deadlineAt: z.date(),
  executionMode: z.enum(["review", "delegated"]).default("review"),
  steps: z.array(z.object({ delayMinutes: z.number().int().min(0).max(43200), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(8).max(10000) })).min(1).max(6),
});

