import { beforeEach, describe, expect, it, vi } from "vitest";

const { listLLMModels, invokeLLM, runOpenRouterTask, parseStructuredAiResult } = vi.hoisted(() => ({ listLLMModels: vi.fn(), invokeLLM: vi.fn(), runOpenRouterTask: vi.fn(), parseStructuredAiResult: vi.fn((_: string, value: string) => JSON.parse(value)) }));

vi.mock("../_core/llm", () => ({ listLLMModels, invokeLLM }));
vi.mock("./openrouter", () => ({ runOpenRouterTask, parseStructuredAiResult }));

import { builtInModelAvailable, DEFAULT_BUILT_IN_PREFERENCE, runControlledAiTask } from "./aiRouting";

describe("controlled AI routing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("keeps the requested Manus free-model preference explicit", () => {
    expect(DEFAULT_BUILT_IN_PREFERENCE).toBe("manus-1.6-lite");
  });

  it("verifies built-in availability from the live catalog", async () => {
    listLLMModels.mockResolvedValue({ data: [{ id: "manus-1.6-lite" }, { id: "gpt-5-nano" }] });
    await expect(builtInModelAvailable("manus-1.6-lite")).resolves.toBe(true);
    await expect(builtInModelAvailable("missing-model")).resolves.toBe(false);
    expect(listLLMModels).toHaveBeenCalledTimes(2);
  });

  it("uses the available built-in model and structured parser", async () => {
    listLLMModels.mockResolvedValue({ data: [{ id: "manus-1.6-lite" }] });
    invokeLLM.mockResolvedValue({ model: "manus-1.6-lite", choices: [{ message: { content: '{"classification":"needs_owner_review","confidence":80}' } }] });
    const result = await runControlledAiTask({ taskType: "classify_reply", input: { text: "hello" } });
    expect(result.selectedModel).toBe("manus-1.6-lite");
    expect(runOpenRouterTask).not.toHaveBeenCalled();
    expect(parseStructuredAiResult).toHaveBeenCalled();
  });

  it("falls back to OpenRouter when the preferred built-in model is unavailable", async () => {
    listLLMModels.mockResolvedValue({ data: [{ id: "gpt-5-nano" }] });
    runOpenRouterTask.mockResolvedValue({ result: { classification: "needs_owner_review" }, selectedModel: "openrouter/free", latencyMs: 12 });
    const result = await runControlledAiTask({ taskType: "classify_reply", input: { text: "hello" } });
    expect(result.selectedModel).toBe("openrouter/free");
    expect(runOpenRouterTask).toHaveBeenCalledWith(expect.objectContaining({ primaryModel: "openrouter/free" }));
  });
});
