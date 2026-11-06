import { z } from 'zod';

export const MAX_JOB_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const jobDocumentMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'] as const;
export const jobDocumentInputSchema = z.object({
  jobId: z.string().min(4).max(36),
  expectedRevision: z.number().int().nonnegative(),
  expectedFingerprint: z.string().length(64),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.enum(jobDocumentMimeTypes),
  contentBase64: z.string().min(4).max(Math.ceil(MAX_JOB_DOCUMENT_BYTES / 3) * 4),
});
