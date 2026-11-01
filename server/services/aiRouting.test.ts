import { beforeEach, describe, expect, it, vi } from "vitest";
const { runOpenRouterTask } = vi.hoisted(() => ({ runOpenRouterTask: vi.fn() }));
vi.mock("./openrouter", async original => ({ ...await original(), runOpenRouterTask }));
import { runControlledAiTask } from "./aiRouting";
describe("free-only controlled AI routing", () => {
 beforeEach(()=>vi.clearAllMocks());
 it("replaces a legacy built-in route and removes paid fallback models",async()=>{
  await runControlledAiTask({taskType:"classify_reply",input:{text:"Synthetic"},primaryModel:"manus-1.6-lite",fallbackModels:["vendor/paid","vendor/model:free"]});
  expect(runOpenRouterTask).toHaveBeenCalledWith(expect.objectContaining({primaryModel:"openrouter/free",fallbackModels:["vendor/model:free"]}));
 });
 it("honors a specific free model without consulting another provider",async()=>{
  await runControlledAiTask({taskType:"classify_reply",input:{},primaryModel:"vendor/model:free"});
  expect(runOpenRouterTask).toHaveBeenCalledWith(expect.objectContaining({primaryModel:"vendor/model:free"}));
 });
});
