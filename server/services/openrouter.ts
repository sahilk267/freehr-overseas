import { z } from "zod";

export type AiTaskType = "classify_reply" | "draft_outreach" | "parse_cv" | "score_match" | "send_reminder" | "reconcile_invoice";

const taskSchemas = {
  classify_reply: z.object({
    classification: z.enum(["interested", "not_interested", "needs_information", "meeting_requested", "opt_out", "unknown"]),
    confidence: z.number().int().min(0).max(100),
    rationale: z.string().min(1).max(600),
    nextAction: z.enum(["prepare_follow_up", "stop_contact", "request_owner_review", "schedule_discovery"]),
  }),
  draft_outreach: z.object({
    subject: z.string().min(1).max(140),
    body: z.string().min(1).max(4000),
    complianceChecklist: z.array(z.enum(["purpose_clear", "opt_out_included", "no_sensitive_inference", "no_unverified_claims"])).min(2),
  }),
  parse_cv: z.object({
    headline: z.string().max(255).nullable(),
    skills: z.array(z.string().min(1).max(80)).max(40),
    totalExperienceYears: z.number().min(0).max(60).nullable(),
    recentRoles: z.array(z.object({ title: z.string().max(160), employer: z.string().max(160).nullable(), years: z.number().min(0).max(30).nullable() })).max(10),
    education: z.array(z.string().max(240)).max(10),
    missingInformation: z.array(z.string().max(240)).max(12),
    confidence: z.number().int().min(0).max(100),
  }),
  score_match: z.object({
    ruleScore: z.number().int().min(0).max(100),
    semanticScore: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
    matchedEvidence: z.array(z.string().min(1).max(500)).max(12),
    missingEvidence: z.array(z.string().min(1).max(500)).max(12),
    lowConfidence: z.boolean(),
    recommendation: z.enum(["review_for_shortlist", "needs_evidence", "not_enough_information"]),
  }),
  send_reminder: z.object({
    subject: z.string().min(1).max(140),
    body: z.string().min(1).max(3000),
    channel: z.enum(["email", "whatsapp", "sms"]),
    sendAfter: z.string().datetime().nullable(),
  }),
  reconcile_invoice: z.object({
    status: z.enum(["payment_pending", "partially_paid", "paid", "overdue", "disputed", "needs_owner_review"]),
    confidence: z.number().int().min(0).max(100),
    rationale: z.string().min(1).max(700),
  }),
} as const;

export type AiTaskResult<T extends AiTaskType> = z.infer<(typeof taskSchemas)[T]>;
export const MAX_AI_INPUT_CHARS = 12_000;

const systemPrompts: Record<AiTaskType, string> = {
  classify_reply: "You classify recruitment-related replies. Never infer protected traits. Return only a JSON object matching the requested schema. If uncertain, use unknown and request_owner_review.",
  draft_outreach: "You draft respectful recruitment communication. Return only a JSON object. Include a concise opt-out instruction. Do not claim prior relationships, personal facts, or guaranteed outcomes. Never include sensitive personal data.",
  parse_cv: "You extract factual, job-relevant CV details only. Do not infer age, gender, ethnicity, religion, disability, health, personality, marital status, or protected information. Return only a JSON object. Use null or missingInformation when evidence is absent.",
  score_match: "You compare job-relevant evidence only. Do not make a hiring decision or rejection. Return only a JSON object. When evidence is weak, set lowConfidence true and use needs_evidence or not_enough_information.",
  send_reminder: "You prepare a polite reminder draft only. Return only a JSON object. Do not state that a message was sent and do not include sensitive information.",
  reconcile_invoice: "You summarize invoice status based only on supplied evidence. Do not issue credit, write off debt, or make a payment decision. Return only a JSON object and use needs_owner_review for uncertainty.",
};

export class OpenRouterConfigurationError extends Error {}
export class OpenRouterTransientError extends Error {}
export class OpenRouterValidationError extends Error {}

export function parseStructuredAiResult<T extends AiTaskType>(taskType: T, rawContent: string): AiTaskResult<T> {
  const normalized = rawContent.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new OpenRouterValidationError("The model returned invalid JSON.");
  }
  const result = taskSchemas[taskType].safeParse(parsed);
  if (!result.success) throw new OpenRouterValidationError(`The model response did not match the ${taskType} schema.`);
  return result.data as AiTaskResult<T>;
}

export async function runOpenRouterTask<T extends AiTaskType>(input: {
  taskType: T;
  input: Record<string, unknown>;
  primaryModel?: string;
  fallbackModels?: string[];
  maxOutputTokens?: number;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new OpenRouterConfigurationError("OPENROUTER_API_KEY is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const primary = input.primaryModel || "openrouter/free";
  const fallbackModels = (input.fallbackModels ?? []).filter(model => model && model !== primary).slice(0, 3);
  const userPayload = JSON.stringify(input.input).slice(0, MAX_AI_INPUT_CHARS);
  const startedAt = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "FreelanceHR Controlled Operations",
      },
      body: JSON.stringify({
        model: primary,
        ...(fallbackModels.length ? { models: fallbackModels } : {}),
        temperature: 0.1,
        max_tokens: input.maxOutputTokens ?? 1200,
        messages: [
          { role: "system", content: systemPrompts[input.taskType] },
          { role: "user", content: `Task: ${input.taskType}\nInput JSON:\n${userPayload}\nReturn JSON only.` },
        ],
      }),
    });
    if (response.status === 401 || response.status === 403) throw new OpenRouterConfigurationError(`OpenRouter rejected the credential with HTTP ${response.status}.`);
    if (response.status === 429 || response.status >= 500) throw new OpenRouterTransientError(`OpenRouter is temporarily unavailable (HTTP ${response.status}).`);
    if (!response.ok) throw new OpenRouterValidationError(`OpenRouter returned HTTP ${response.status}.`);
    const payload = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new OpenRouterValidationError("OpenRouter returned no assistant content.");
    return { result: parseStructuredAiResult(input.taskType, content), selectedModel: payload.model ?? primary, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof OpenRouterConfigurationError || error instanceof OpenRouterTransientError || error instanceof OpenRouterValidationError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new OpenRouterTransientError("OpenRouter request timed out.");
    throw new OpenRouterTransientError(error instanceof Error ? error.message : "OpenRouter request failed.");
  } finally {
    clearTimeout(timeout);
  }
}
