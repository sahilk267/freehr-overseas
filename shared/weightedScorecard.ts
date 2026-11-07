import {z} from 'zod';
export const criterionRatingSchema=z.object({criterionIndex:z.number().int().min(0).max(11),score:z.number().int().min(0).max(5).nullable(),source:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('profile'),quote:z.string().trim().min(1).max(500)}),
 z.object({kind:z.literal('parsed_document'),documentId:z.string().min(4).max(36),quote:z.string().trim().min(1).max(500)}),
 z.object({kind:z.literal('candidate_response'),inviteId:z.string().min(4).max(36),responseRevision:z.number().int().positive(),questionId:z.string().max(40),quote:z.string().trim().min(1).max(500)}),
 z.object({kind:z.literal('owner_observation'),observation:z.string().trim().min(8).max(2000),quote:z.string().trim().min(1).max(500)})
 ]).optional()});
export const weightedScorecardInput=z.object({candidateId:z.string().min(4).max(36),jobId:z.string().min(4).max(36),expectedRevision:z.number().int().nonnegative(),expectedCandidateFingerprint:z.string().length(64),expectedRequirementFingerprint:z.string().length(64),ratings:z.array(criterionRatingSchema).max(12),reason:z.string().trim().min(8).max(2000)});
export function calculateWeightedScorecard(criteria:{criterion:string;weight:number;required?:boolean}[],ratings:{criterionIndex:number;score?:number|null}[]){
 if(!criteria.length||criteria.reduce((n,c)=>n+c.weight,0)!==100||criteria.some(c=>!Number.isInteger(c.weight)||c.weight<1||c.weight>100))throw Error('A valid employer scorecard totaling 100 is required.');
 if(new Set(ratings.map(r=>r.criterionIndex)).size!==ratings.length||ratings.some(r=>r.criterionIndex<0||r.criterionIndex>=criteria.length||r.score!=null&&(!Number.isInteger(r.score)||r.score<0||r.score>5)))throw Error('Score each current criterion at most once, using 0–5 or unknown.');
 let earned=0,assessedWeight=0;const missingRequired:string[]=[],reviewRequired:string[]=[];
 const rows=criteria.map((c,i)=>{const score=ratings.find(r=>r.criterionIndex===i)?.score??null;if(score===null){if(c.required)missingRequired.push(c.criterion);}else{earned+=c.weight*score/5;assessedWeight+=c.weight;if(c.required&&score===0)reviewRequired.push(c.criterion);}return {...c,score,contribution:score===null?null:Math.round(c.weight*score/5*100)/100};});
 return {lowerScore:Math.round(earned*100)/100,upperScore:Math.round((earned+100-assessedWeight)*100)/100,assessedWeight,unknownWeight:100-assessedWeight,missingRequired,reviewRequired,rows,finalDisposition:false as const};
}
