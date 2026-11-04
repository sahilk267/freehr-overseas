import { TRPCError } from '@trpc/server';
export type Window = {start:Date;end:Date};
const ms = (date:Date) => new Date(date).getTime();
function normalize(windows:Window[]) {
  if (!windows.length || windows.length>100 || windows.some(w=>!Number.isFinite(ms(w.start))||!Number.isFinite(ms(w.end))||ms(w.end)<=ms(w.start))) throw new TRPCError({code:'BAD_REQUEST',message:'Supply 1–100 valid increasing availability windows per participant.'});
  const sorted=windows.map(w=>({start:ms(w.start),end:ms(w.end)})).sort((a,b)=>a.start-b.start),merged:typeof sorted=[];
  for(const w of sorted){const last=merged.at(-1);if(last&&w.start<=last.end)last.end=Math.max(last.end,w.end);else merged.push({...w});}return merged;
}
export function commonAvailability(input:{candidate:Window[];interviewer:Window[];busy?:Window[];durationMinutes:number;bufferMinutes:number;now?:Date}) {
  if(!Number.isInteger(input.durationMinutes)||input.durationMinutes<15||input.durationMinutes>240||!Number.isInteger(input.bufferMinutes)||input.bufferMinutes<0||input.bufferMinutes>60)throw new TRPCError({code:'BAD_REQUEST',message:'Choose a 15–240 minute interview and 0–60 minute buffer.'});
  const candidate=normalize(input.candidate),interviewer=normalize(input.interviewer),all=[...candidate,...interviewer];
  if(Math.max(...all.map(w=>w.end))-Math.min(...all.map(w=>w.start))>31*86400000)throw new TRPCError({code:'BAD_REQUEST',message:'Availability windows must fit within 31 days.'});
  const busy=input.busy?.length?normalize(input.busy):[],duration=input.durationMinutes*60000,buffer=input.bufferMinutes*60000;
  const floor=ms(input.now??new Date());if(!Number.isFinite(floor))throw new TRPCError({code:'BAD_REQUEST',message:'Invalid check time.'});
  const slots:Window[]=[];let i=0,j=0;
  while(i<candidate.length&&j<interviewer.length){const a=candidate[i],b=interviewer[j],start=Math.max(a.start,b.start,floor),end=Math.min(a.end,b.end);let cursor=Math.ceil(Math.max(start,slots.length?ms(slots.at(-1)!.end)+buffer:start)/300000)*300000;
    while(cursor+duration<=end&&slots.length<10){const conflict=busy.find(w=>w.start-buffer<cursor+duration&&w.end+buffer>cursor);if(conflict){cursor=Math.ceil((conflict.end+buffer)/300000)*300000;continue;}slots.push({start:new Date(cursor),end:new Date(cursor+duration)});cursor+=duration+buffer;}
    if(slots.length===10)break;if(a.end<=b.end)i++;else j++;
  }
  return {slots,reservation:false,participantAcceptance:false,checkedAt:new Date(floor)};
}
