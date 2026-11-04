import {createHash,createHmac} from 'node:crypto';
import {TRPCError} from '@trpc/server';
export type AvailabilityMailScope={purpose?:"interview_confirmation";ownerId:number;inviteId:string;groupId:string;revision:number;participant:string;nonce:string;keyId:string;recipientHash:string;appOrigin:string};
export const availabilityMailValues=(s:AvailabilityMailScope)=>[s.ownerId,s.inviteId,s.groupId,s.revision,s.participant,s.nonce,s.keyId,s.recipientHash,s.appOrigin,...(s.purpose?[s.purpose]:[])];
function secret(){const value=(process.env.SESSION_SECRET||process.env.JWT_SECRET||'').trim();if(value.length<32)throw new TRPCError({code:'PRECONDITION_FAILED',message:'A stable 32-character session secret is required for private link delivery.'});return value;}
export const availabilityMailKeyId=()=>createHmac('sha256',secret()).update('availability-mail-key-id-v1').digest('hex');
export function availabilityMailOrigin(){try{const url=new URL(process.env.APP_BASE_URL||'');if(url.protocol!=='https:'||url.username||url.password)throw Error();return url.origin;}catch{throw new TRPCError({code:'PRECONDITION_FAILED',message:'Configure the HTTPS application origin before preparing private link email.'});}}
export function availabilityMailToken(s:AvailabilityMailScope){if(s.keyId!==availabilityMailKeyId()||s.appOrigin!==availabilityMailOrigin())throw new TRPCError({code:'PRECONDITION_FAILED',message:'Private link configuration changed; revoke this request and prepare a new one.'});if(s.purpose!==undefined&&s.purpose!=='interview_confirmation')throw new TRPCError({code:'PRECONDITION_FAILED',message:'Private link purpose is unsupported.'});return createHmac('sha256',secret()).update((s.purpose?'interview-confirmation-email-v1:':'availability-email-v1:')+JSON.stringify(availabilityMailValues(s))).digest('base64url');}
export const availabilityTokenHash=(token:string)=>createHash('sha256').update(JSON.stringify(token)).digest('hex');
export const AVAILABILITY_LINK_MARKER='[Your private availability link is generated securely when this approved email is sent.]';

export const CONFIRMATION_LINK_MARKER='[Your private interview confirmation link is generated securely when this approved email is sent.]';
