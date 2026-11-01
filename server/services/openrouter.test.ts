import { describe, expect, it, vi } from "vitest";
import { OpenRouterValidationError, parseStructuredAiResult, runOpenRouterTask, isFreeOpenRouterModel } from "./openrouter";

describe("OpenRouter structured-output guard", () => {
  it("accepts only the free router and explicit free model IDs", () => {
    expect(isFreeOpenRouterModel("openrouter/free")).toBe(true);
    expect(isFreeOpenRouterModel("vendor/model:free")).toBe(true);
    for (const value of ["vendor/paid", "manus-1.6-lite", "vendor/model:free:online", "vendor/model:free "]) expect(isFreeOpenRouterModel(value)).toBe(false);
  });

  it("rejects paid primary and fallback routes before any provider request", async () => {
    const prior = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "synthetic-no-network-key";
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      await expect(runOpenRouterTask({ taskType: "classify_reply", input: {}, primaryModel: "vendor/paid" })).rejects.toThrow(/Paid fallback is disabled/);
      await expect(runOpenRouterTask({ taskType: "classify_reply", input: {}, fallbackModels: ["vendor/paid"] })).rejects.toThrow(/Paid fallback is disabled/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); if (prior === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prior; }
  });

  it("requests structured JSON and validates the free-model result", async () => {
    const prior = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "synthetic-no-network-key";
    const output = { classification: "opt_out", confidence: 99, rationale: "Explicit stop request", nextAction: "stop_contact" };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ model: "vendor/model:free", choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 }));
    try {
      const result = await runOpenRouterTask({ taskType: "classify_reply", input: { reply: "Stop" } });
      expect(result.result).toEqual(output);
      const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(body.model).toBe("openrouter/free");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages[0].content).toContain("Required JSON schema");
    } finally { fetcher.mockRestore(); if (prior === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prior; }
  });
  it("accepts a valid low-confidence evidence match without turning it into a hiring decision", () => {
    const result = parseStructuredAiResult("score_match", JSON.stringify({
      ruleScore: 68,
      semanticScore: 71,
      confidence: 62,
      matchedEvidence: ["Five years of TypeScript experience"],
      missingEvidence: ["No evidence of required AWS delivery"],
      lowConfidence: true,
      recommendation: "needs_evidence",
    }));
    expect(result.lowConfidence).toBe(true);
    expect(result.recommendation).toBe("needs_evidence");
  });

  it("rejects malformed or schema-incompatible model content", () => {
    expect(() => parseStructuredAiResult("classify_reply", "not JSON")).toThrow(OpenRouterValidationError);
    expect(() => parseStructuredAiResult("classify_reply", JSON.stringify({ classification: "hire", confidence: 100 }))).toThrow(OpenRouterValidationError);
  });

  it("requires an explicit opt-out safeguard in an outreach draft", () => {
    expect(() => parseStructuredAiResult("draft_outreach", JSON.stringify({
      subject: "Opportunity",
      body: "I would like to speak with you.",
      complianceChecklist: ["purpose_clear"],
    }))).toThrow(OpenRouterValidationError);
  });
});
