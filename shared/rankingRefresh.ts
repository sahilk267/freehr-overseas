import {z} from 'zod';
export const rankingRefreshSettings=z.object({
 enabled:z.boolean(),query:z.string().trim().max(120).default(''),intervalMinutes:z.number().int().min(15).max(1440).default(60),
 maxRuns:z.number().int().min(1).max(100).default(10),expiresAt:z.coerce.date(),
 queueAi:z.boolean().default(false),maxPerRun:z.number().int().min(1).max(10).default(3),maxAiTasks:z.number().int().min(0).max(100).default(0),minPriority:z.number().int().min(0).max(100).default(80),
});
export type RankingRefreshSettings=z.infer<typeof rankingRefreshSettings>;
export const rankingRefreshInput=rankingRefreshSettings.extend({jobId:z.string().min(4).max(36),expectedRevision:z.number().int().nonnegative()});
