import { z } from "zod";
const id = z.string().min(4).max(36),
  hash = z.string().length(64),
  note = z.string().trim().min(8).max(2000);
export const feedbackPanelInput = z
  .object({
    interviewId: id,
    expectedFingerprint: hash,
    expectedRevision: z.number().int().nonnegative(),
    reviewers: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z0-9_-]{2,40}$/),
            name: z.string().trim().min(2).max(160),
            contactId: id.optional(),
          })
          .strict()
      )
      .min(1)
      .max(12),
    dueAt: z.date(),
    reason: note,
  })
  .strict();
export const structuredFeedbackInput = z
  .object({
    interviewId: id,
    expectedFingerprint: hash,
    panelRevision: z.number().int().positive(),
    reviewerKey: z.string().min(2).max(40),
    requestKey: z.string().trim().min(8).max(100),
    supersedesId: id.optional(),
    rawFeedback: z.string().trim().min(12).max(12000),
    ratings: z
      .array(
        z
          .object({
            criterionIndex: z.number().int().min(0).max(11),
            score: z.number().int().min(0).max(5).nullable(),
            quote: z.string().trim().min(1).max(500).optional(),
          })
          .strict()
      )
      .max(12),
    limitations: z.string().trim().max(2000).default(""),
    reason: note,
  })
  .strict();
export const resolveFeedbackInput = z
  .object({
    interviewId: id,
    expectedFingerprint: hash,
    panelRevision: z.number().int().positive(),
    expectedResponseHash: hash,
    nextAction: z.enum([
      "request_clarification",
      "consider_next_round",
      "owner_review",
    ]),
    evidence: note,
  })
  .strict();
export function compareInterviewFeedback(
  criteria: { criterion: string; weight: number; required?: boolean }[],
  responses: {
    reviewerKey: string;
    ratings: { criterionIndex: number; score: number | null }[];
  }[],
  expectedReviewers: string[]
) {
  const missingReviewers = expectedReviewers.filter(
    key => !responses.some(r => r.reviewerKey === key)
  );
  return {
    missingReviewers,
    rows: criteria.map((c, index) => {
      const values = responses.map(r => ({
          reviewerKey: r.reviewerKey,
          score: r.ratings.find(v => v.criterionIndex === index)?.score ?? null,
        })),
        known = values
          .filter(v => v.score !== null)
          .map(v => v.score as number),
        minimum = known.length ? Math.min(...known) : null,
        maximum = known.length ? Math.max(...known) : null;
      return {
        ...c,
        criterionIndex: index,
        values,
        minimum,
        maximum,
        conflict:
          minimum !== null && maximum !== null && maximum - minimum >= 2,
        unknownReviewers: expectedReviewers.filter(
          key => !values.some(v => v.reviewerKey === key && v.score !== null)
        ),
      };
    }),
    finalDisposition: false as const,
    independentlyVerified: false as const,
  };
}
