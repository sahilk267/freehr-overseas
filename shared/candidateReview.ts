import {z} from 'zod';
import {candidateEvidenceFieldsSchema} from './candidateEvidence';
export const candidateResponseFieldsSchema=candidateEvidenceFieldsSchema.omit({observedAt:true,validUntil:true,sourceNote:true}).strict();
export const candidateReviewFields=['skills','totalExperienceYears','workModels','locations','compensation','noticePeriodDays','availableFrom'] as const;
export const candidateReviewCapability=z.object({id:z.string().min(4).max(36),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
export const candidateReviewResponseSchema=candidateReviewCapability.extend({expectedRevision:z.number().int().min(0).max(5),fields:candidateResponseFieldsSchema,answers:z.record(z.string().max(40),z.string().trim().min(1).max(2000)).refine(a=>Object.keys(a).length<=24).default({}),consentToProcess:z.literal(true),noticeVersion:z.literal('candidate-review-v1')}).strict();
