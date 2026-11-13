import { z } from "zod";
export const submissionFields = [
  "skills",
  "workModels",
  "locations",
  "noticePeriodDays",
] as const;
const id = z.string().min(4).max(36);
export const prepareSubmissionInput = z
  .object({
    candidateId: id,
    jobId: id,
    contactId: id,
    senderIdentityId: id,
    expectedVersion: z.number().int().nonnegative(),
    fields: z.array(z.enum(submissionFields)).min(1).max(4),
    expiresHours: z.number().int().min(1).max(336).default(72),
    transactionalOtp: z.literal(true),
    requestKey: z.string().min(8).max(100),
  })
  .strict();
export const submissionCapability = z
  .object({ id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const submissionSession = submissionCapability
  .extend({
    sessionId: id,
    sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const submissionFeedback = submissionSession
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    requestKey: z.string().min(8).max(100),
    outcome: z.enum([
      "clarification_requested",
      "interview_interest",
      "not_progressing",
      "reviewed",
    ]),
    note: z.string().trim().min(8).max(4000),
    noticeVersion: z.literal("client-submission-v1"),
  })
  .strict();
