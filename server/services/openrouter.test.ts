import { describe, expect, it } from "vitest";
import { OpenRouterValidationError, parseStructuredAiResult } from "./openrouter";

describe("OpenRouter structured-output guard", () => {
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
