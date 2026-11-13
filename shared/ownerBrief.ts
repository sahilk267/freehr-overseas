import { z } from "zod";
import { isValidTimezone } from "./dateTime";
export const ownerBriefFields = z
  .object({
    enabled: z.boolean().default(false),
    cadence: z.enum(["daily", "weekly"]).default("daily"),
    time: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    timezone: z.string().refine(isValidTimezone).default("Asia/Kolkata"),
    weekday: z.number().int().min(1).max(7).default(1),
    lookbackDays: z.number().int().min(1).max(30).default(7),
    attentionHours: z.number().int().min(1).max(168).default(24),
    retentionDays: z.number().int().min(7).max(90).default(30),
  })
  .strict();
export type OwnerBriefFields = z.infer<typeof ownerBriefFields>;
export const ownerBriefConfigure = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    fields: ownerBriefFields,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export const ownerBriefQuery = z
  .object({
    kind: z
      .enum([
        "all",
        "approval",
        "queue",
        "incident",
        "finance",
        "integrity",
        "followup",
      ])
      .default("all"),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const OWNER_BRIEF_VERSION = "owner-operating-brief-v1";
