import {z} from 'zod';
import {parseMoney} from './money';
export const agreementTermsSchema=z.object({
 feeType:z.enum(['percentage','fixed']),feeValue:z.string().trim().regex(/^\d+(?:\.\d{1,4})?$/).max(32),currency:z.string().trim().regex(/^[A-Za-z]{3}$/).transform(v=>v.toUpperCase()),
 guaranteeDays:z.number().int().min(0).max(730).default(90),paymentTermsDays:z.number().int().min(0).max(365).default(30),ownershipDays:z.number().int().min(1).max(1095).default(180),
 termsText:z.string().trim().min(50).max(12000),taxRateBasisPoints:z.number().int().min(0).max(10000).default(0),
}).strict().superRefine((t,ctx)=>{try{if(t.feeType==='fixed')parseMoney(t.feeValue,t.currency);else if(decimalScaled(t.feeValue)<=0n||decimalScaled(t.feeValue)>1000000n)throw Error('Percentage must be greater than zero and at most 100.');}catch(e){ctx.addIssue({code:'custom',path:['feeValue'],message:(e as Error).message});}});
export type AgreementTerms=z.infer<typeof agreementTermsSchema>;
export function decimalScaled(value:string){const [whole,fraction='']=value.split('.');return BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));}
export function calculateContractFee(terms:AgreementTerms,annualCompensationMinorUnits?:number){
 const t=agreementTermsSchema.parse(terms);let amount:bigint;
 if(t.feeType==='fixed')amount=BigInt(parseMoney(t.feeValue,t.currency));
 else {if(!Number.isInteger(annualCompensationMinorUnits)||annualCompensationMinorUnits<=0||annualCompensationMinorUnits>2147483647)throw Error('An explicit positive annual compensation in currency minor units is required.');const numerator=BigInt(annualCompensationMinorUnits)*decimalScaled(t.feeValue);amount=(numerator+500000n)/1000000n;}
 const tax=(amount*BigInt(t.taxRateBasisPoints)+5000n)/10000n;
 if(amount<=0n||amount+tax>2147483647n)throw Error('The contract fee and tax exceed the supported amount range.');
 return {amount:Number(amount),taxAmount:Number(tax),totalAmount:Number(amount+tax),currency:t.currency,rounding:'half_up_minor_unit' as const};
}
