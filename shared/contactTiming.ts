import { z } from "zod";
import { isValidTimezone } from "./dateTime";
const id = z.string().min(4).max(36),
  clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const contactTimingFields = z
  .object({
    notBefore: z.coerce.date().optional(),
    timezone: z.string().min(2).max(64).refine(isValidTimezone),
    window: z
      .object({
        start: clock,
        end: clock,
        businessDaysOnly: z.boolean().default(false),
      })
      .strict()
      .optional(),
    preferredChannel: z
      .enum(["email", "phone", "sms", "whatsapp"])
      .default("email"),
    preferredLanguage: z.string().trim().min(2).max(35).optional(),
    validUntil: z.coerce.date(),
  })
  .strict();
export type ContactTimingFields = z.infer<typeof contactTimingFields>;
export const contactTimingSave = z
  .object({
    planId: id,
    expectedRevision: z.number().int().nonnegative(),
    messageId: id,
    sourceQuote: z.string().trim().min(4).max(800),
    fields: contactTimingFields,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
