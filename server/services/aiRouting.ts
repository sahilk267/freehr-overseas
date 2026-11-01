import { isFreeOpenRouterModel, runOpenRouterTask, type AiTaskType } from "./openrouter";

export type ControlledAiInput<T extends AiTaskType> = {
  taskType: T;
  input: Record<string, unknown>;
  primaryModel?: string;
  fallbackModels?: string[];
  maxOutputTokens?: number;
};

/** Legacy built-in/paid preferences cannot override this deployment's free-only policy. */
export async function runControlledAiTask<T extends AiTaskType>(input: ControlledAiInput<T>) {
  const preferred = input.primaryModel || process.env.FREELANCEHR_BUILT_IN_MODEL || "openrouter/free";
  return runOpenRouterTask({ ...input,
    primaryModel: isFreeOpenRouterModel(preferred) ? preferred : "openrouter/free",
    fallbackModels: (input.fallbackModels ?? []).filter(isFreeOpenRouterModel),
  });
}
