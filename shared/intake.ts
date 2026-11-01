import { z } from "zod";

const optionalText = (max: number) => z.string().trim().max(max).optional();
export const candidateIntakeRecord = z.object({
  externalKey: z.string().trim().min(1).max(120),
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().optional(),
  phone: optionalText(64),
  headline: optionalText(255), location: optionalText(160), availability: optionalText(120),
  sourceUrl: z.string().url().max(2000).optional(),
}).strict().refine(value => Boolean(value.email || /^\+[1-9]\d{7,14}$/.test((value.phone ?? "").replace(/[\s().-]/g, ""))), "Candidate imports require an email or international phone number.");

export const prospectIntakeRecord = z.object({
  externalKey: z.string().trim().min(1).max(120), name: z.string().trim().min(2).max(255), domain: z.string().trim().min(3).max(255),
  sector: optionalText(120), location: optionalText(160), hiringSignal: optionalText(2000), sourceUrl: z.string().url().max(2000).optional(),
  contact: z.object({ name: z.string().trim().min(2).max(160), email: z.string().trim().email(), title: optionalText(160), phone: optionalText(64) }).strict().optional(),
}).strict();

export const intakeBatchInput = z.object({
  batchKey: z.string().trim().min(8).max(80),
  kind: z.enum(["candidate", "prospect"]),
  records: z.array(z.unknown()).min(1).max(50),
}).strict();

export type IntakeOutcome = { externalKeyHash: string; status: "created" | "reused" | "conflict" | "blocked"; resourceId?: string; contactId?: string; reason?: string };
