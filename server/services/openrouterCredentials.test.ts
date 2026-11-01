import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { verifyOpenRouterCredentials } from './openrouter';
describe('credential health without leaking account data',()=>{
 let saved:Record<string,string|undefined>;
 beforeEach(()=>{saved={OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,OPENROUTER_FALLBACK_API_KEY:process.env.OPENROUTER_FALLBACK_API_KEY};process.env.OPENROUTER_API_KEY='synthetic-primary';process.env.OPENROUTER_FALLBACK_API_KEY='synthetic-secondary';});
 afterEach(()=>{vi.restoreAllMocks();for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const ok=()=>new Response(JSON.stringify({data:{label:'private label',usage:123}}),{status:200});
 it('verifies two distinct keys and returns neither credentials nor account fields',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>ok());const r=await verifyOpenRouterCredentials();expect(r.distinctCredentialCount).toBe(2);expect(r.results.every(x=>x.verified)).toBe(true);expect(f).toHaveBeenCalledTimes(2);expect(JSON.stringify(r)).not.toMatch(/synthetic-|private label|usage/);
 });
 it('deduplicates identical keys',async()=>{
  process.env.OPENROUTER_FALLBACK_API_KEY='synthetic-primary';const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(ok());expect((await verifyOpenRouterCredentials()).distinctCredentialCount).toBe(1);expect(f).toHaveBeenCalledTimes(1);
 });
 it('reports rejected primary and valid backup independently',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(ok());const r=await verifyOpenRouterCredentials();expect(r.results.map(x=>x.status)).toEqual(['credentials_rejected','verified']);
 });
 it('defers further probes after provider throttling',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:429}));const r=await verifyOpenRouterCredentials();expect(r.distinctCredentialCount).toBe(2);expect(r.results.map(x=>x.status)).toEqual(['rate_limited','deferred_rate_limit']);expect(f).toHaveBeenCalledTimes(1);
 });
 it('does not send missing or placeholder credentials to the provider',async()=>{
  delete process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_FALLBACK_API_KEY='REPLACE_WITH_REAL_KEY';const f=vi.spyOn(globalThis,'fetch');expect((await verifyOpenRouterCredentials()).results.every(x=>!x.configured)).toBe(true);expect(f).not.toHaveBeenCalled();
 });
});
