import { invokeLLM, listLLMModels } from "../_core/llm";
import { parseStructuredAiResult, runOpenRouterTask, type AiTaskType } from "./openrouter";

export const DEFAULT_BUILT_IN_PREFERENCE = "manus-1.6-lite";

const prompts: Record<AiTaskType, string> = {
  classify_reply: "Classify the recruitment reply. Never infer protected traits. Return JSON only; uncertainty must request owner review.",
  draft_outreach: "Draft respectful recruitment communication. Include an opt-out instruction and no unverified claims. Return JSON only.",
  parse_cv: "Extract factual job-relevant CV details only. Never infer protected information. Return JSON only.",
  score_match: "Compare job-relevant evidence only. Do not make a hiring decision or rejection. Return JSON only.",
  send_reminder: "Prepare a polite reminder draft only. Do not state that it was sent. Return JSON only.",
  reconcile_invoice: "Summarize invoice status from supplied evidence. Never make a payment decision. Return JSON only.",
};

export type ControlledAiInput<T extends AiTaskType> = {
  taskType: T;
  input: Record<string, unknown>;
  primaryModel?: string;
  fallbackModels?: string[];
  maxOutputTokens?: number;
};

export async function builtInModelAvailable(model: string) {
  try {
    const catalog = await listLLMModels();
    return catalog.data.some(entry => entry.id === model);
  } catch {
    return false;
  }
}

async function runBuiltIn<T extends AiTaskType>(input: ControlledAiInput<T>, model: string) {
  const response = await invokeLLM({
    model,
    messages: [
      { role: "system", content: prompts[input.taskType] },
      { role: "user", content: `Task: ${input.taskType}\nInput JSON:\n${JSON.stringify(input.input).slice(0, 12000)}\nReturn JSON only.` },
    ],
    responseFormat: { type: "json_object" },
    maxTokens: input.maxOutputTokens ?? 1200,
  });
  const content = response.choices[0]?.message.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Built-in model returned no assistant content.");
  return { result: parseStructuredAiResult(input.taskType, content), selectedModel: response.model, latencyMs: 0 };
}

export async function runControlledAiTask<T extends AiTaskType>(input: ControlledAiInput<T>) {
  const preferred = input.primaryModel || process.env.FREELANCEHR_BUILT_IN_MODEL || DEFAULT_BUILT_IN_PREFERENCE;
  const isOpenRouterRoute = preferred.startsWith("openrouter/") || preferred === "openrouter/free";
  if (!isOpenRouterRoute && await builtInModelAvailable(preferred)) {
    try {
      return await runBuiltIn(input, preferred);
    } catch {
      // Built-in output/provider failures fail over to the controlled OpenRouter route.
    }
  }
  return runOpenRouterTask({ ...input, primaryModel: isOpenRouterRoute ? preferred : "openrouter/free" });
}
