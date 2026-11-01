import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenRouterTask, OpenRouterRateLimitError } from "./openrouter";
const output={classification:"opt_out",confidence:99,rationale:"Explicit stop",nextAction:"stop_contact"};
const success=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{status:200});
const task={taskType:"classify_reply" as const,input:{reply:"Synthetic stop request"}};
describe("bounded free model and credential failover",()=>{
 let saved: Record<string,string|undefined>;
 beforeEach(()=>{saved=Object.fromEntries(['OPENROUTER_API_KEY','OPENROUTER_FALLBACK_API_KEY','OPENROUTER_FREE_FALLBACK_MODELS'].map(k=>[k,process.env[k]]));process.env.OPENROUTER_API_KEY='synthetic-primary';process.env.OPENROUTER_FALLBACK_API_KEY='synthetic-secondary';delete process.env.OPENROUTER_FREE_FALLBACK_MODELS;});
 afterEach(()=>{vi.restoreAllMocks();for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 it("uses the second key only after credential rejection, keeping the same free model",async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(success());await runOpenRouterTask(task);
  expect(f).toHaveBeenCalledTimes(2);expect((f.mock.calls[1][1]!.headers as any).Authorization).toBe('Bearer synthetic-secondary');expect(JSON.parse(f.mock.calls[1][1]!.body as string).model).toBe('openrouter/free');
 });
 it("tries a different free model after provider failure using the same valid key",async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(success());await runOpenRouterTask(task);
  expect(JSON.parse(f.mock.calls[1][1]!.body as string).model).toBe('nvidia/nemotron-3.5-super-vl:free');expect((f.mock.calls[1][1]!.headers as any).Authorization).toBe('Bearer synthetic-primary');
 });
 it("does not rotate keys or models to evade a rate limit",async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:429}));await expect(runOpenRouterTask(task)).rejects.toBeInstanceOf(OpenRouterRateLimitError);expect(f).toHaveBeenCalledTimes(1);
 });
 it("does not retry an account credit restriction with another key",async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:402}));await expect(runOpenRouterTask(task)).rejects.toThrow(/quota or credit/);expect(f).toHaveBeenCalledTimes(1);
 });
 it("bounds total requests across both credentials and deduplicates models",async()=>{
  process.env.OPENROUTER_FREE_FALLBACK_MODELS='vendor/a:free,vendor/b:free,vendor/c:free,vendor/d:free';
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:401})).mockImplementation(async()=>new Response('',{status:503}));await expect(runOpenRouterTask(task)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(4);
 });
 it("rejects a paid environment fallback before sending any request",async()=>{
  process.env.OPENROUTER_FREE_FALLBACK_MODELS='vendor/paid';const f=vi.spyOn(globalThis,'fetch');await expect(runOpenRouterTask(task)).rejects.toThrow(/Paid fallback/);expect(f).not.toHaveBeenCalled();
 });
 it("can use a configured fallback key when the primary key is absent",async()=>{
  delete process.env.OPENROUTER_API_KEY;const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(success());await runOpenRouterTask(task);expect((f.mock.calls[0][1]!.headers as any).Authorization).toBe('Bearer synthetic-secondary');
 });
});
