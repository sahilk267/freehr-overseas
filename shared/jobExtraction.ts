import {z} from 'zod';
export const jobExtractionFields=['title','department','location','workModel','compensationMin','compensationMax','currency','compensationPeriod','experienceMinYears','experienceMaxYears','mustHaveSkills','niceToHaveSkills','trainableSkills','responsibilities','hiringProcess','headcount','employmentType','noticePeriodDays','targetJoiningAt','timezone'] as const;
export type JobExtractionField=typeof jobExtractionFields[number];
export const jobExtractionResultSchema=z.object({facts:z.array(z.object({field:z.enum(jobExtractionFields),value:z.string().trim().min(1).max(600),quote:z.string().trim().min(1).max(700)})).max(32),unresolved:z.array(z.string().trim().min(1).max(240)).max(12),confidence:z.number().int().min(0).max(100)});
export type JobExtractionResult=z.infer<typeof jobExtractionResultSchema>;
export const jobExtractionListFields=new Set<JobExtractionField>(['mustHaveSkills','niceToHaveSkills','trainableSkills','responsibilities','hiringProcess']);
