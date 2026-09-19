import { describe, expect, it } from "vitest";
import { evaluateAutoApproval, PolicyConfig } from "./policyEngine";

describe("policyEngine.evaluateAutoApproval", () => {
  const samplePolicy: PolicyConfig = {
    autoApprovalRules: [
      {
        actionType: "invoice_issue",
        conditions: [
          { field: "amount", op: "lte", value: 50000 },
          { field: "currency", op: "eq", value: "USD" },
          { field: "riskTier", op: "in", value: ["low", "medium"] },
        ],
      },
      {
        actionType: "client_onboarding",
        conditions: [
          { field: "companyType", op: "eq", value: "client" },
          { field: "creditScore", op: "gte", value: 700 },
        ],
      },
    ],
  };

  describe("1. No policy configured → false (fail-safe default)", () => {
    it("returns false when policyConfig is null", () => {
      expect(
        evaluateAutoApproval(null, "invoice_issue", {
          amount: 10000,
          currency: "USD",
          riskTier: "low",
        }),
      ).toBe(false);
    });

    it("returns false when policyConfig is undefined", () => {
      expect(
        evaluateAutoApproval(undefined, "invoice_issue", {
          amount: 10000,
          currency: "USD",
          riskTier: "low",
        }),
      ).toBe(false);
    });

    it("returns false when policyConfig is empty object or missing autoApprovalRules", () => {
      expect(
        evaluateAutoApproval({}, "invoice_issue", { amount: 1000 }),
      ).toBe(false);
      expect(
        evaluateAutoApproval({ aiDailyLimit: 45 }, "invoice_issue", { amount: 1000 }),
      ).toBe(false);
    });

    it("returns false when autoApprovalRules is an empty array", () => {
      expect(
        evaluateAutoApproval(
          { autoApprovalRules: [] },
          "invoice_issue",
          { amount: 1000 },
        ),
      ).toBe(false);
    });

    it("returns false when policyConfig is a primitive or invalid JSON", () => {
      expect(evaluateAutoApproval(12345, "invoice_issue", { amount: 1000 })).toBe(false);
      expect(evaluateAutoApproval(true, "invoice_issue", { amount: 1000 })).toBe(false);
      expect(evaluateAutoApproval("{invalid json", "invoice_issue", { amount: 1000 })).toBe(false);
    });
  });

  describe("2. Rule with all conditions met → true", () => {
    it("returns true when every condition passes for invoice_issue (lte, eq, in)", () => {
      const payload = {
        amount: 45000,
        currency: "USD",
        riskTier: "low",
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(true);
    });

    it("returns true on exact boundary values for lte and gte", () => {
      expect(
        evaluateAutoApproval(samplePolicy, "invoice_issue", {
          amount: 50000, // exact boundary for lte: 50000
          currency: "USD",
          riskTier: "medium", // boundary in array
        }),
      ).toBe(true);

      expect(
        evaluateAutoApproval(samplePolicy, "client_onboarding", {
          companyType: "client",
          creditScore: 700, // exact boundary for gte: 700
        }),
      ).toBe(true);
    });

    it("returns true when policyConfig is provided as valid serialized JSON string", () => {
      const serialized = JSON.stringify(samplePolicy);
      expect(
        evaluateAutoApproval(serialized, "client_onboarding", {
          companyType: "client",
          creditScore: 750,
        }),
      ).toBe(true);
    });
  });

  describe("3. Rule with one condition failing → false", () => {
    it("fails when lte condition is exceeded", () => {
      const payload = {
        amount: 50001, // exceeds 50000
        currency: "USD",
        riskTier: "low",
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(false);
    });

    it("fails when eq condition does not match", () => {
      const payload = {
        amount: 25000,
        currency: "EUR", // expected USD
        riskTier: "low",
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(false);
    });

    it("fails when in condition element is absent", () => {
      const payload = {
        amount: 25000,
        currency: "USD",
        riskTier: "high", // not in ["low", "medium"]
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(false);
    });

    it("fails when gte condition is below threshold", () => {
      const payload = {
        companyType: "client",
        creditScore: 699, // below 700
      };
      expect(evaluateAutoApproval(samplePolicy, "client_onboarding", payload)).toBe(false);
    });

    it("fails when actionType does not match any configured rule", () => {
      expect(
        evaluateAutoApproval(samplePolicy, "placement_confirmation", {
          amount: 1000,
          currency: "USD",
        }),
      ).toBe(false);
    });
  });

  describe("4. Malformed/missing field in payload → false (fail-safe, never throws)", () => {
    it("fails when required field is missing completely from payload", () => {
      const payload = {
        amount: 25000,
        // currency is omitted
        riskTier: "low",
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(false);
    });

    it("fails when required field is undefined in payload", () => {
      const payload = {
        amount: 25000,
        currency: undefined,
        riskTier: "low",
      };
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", payload)).toBe(false);
    });

    it("fails when numeric field has wrong type (string instead of number) for comparison operators", () => {
      expect(
        evaluateAutoApproval(samplePolicy, "invoice_issue", {
          amount: "45000" as any, // string instead of number
          currency: "USD",
          riskTier: "low",
        }),
      ).toBe(false);

      expect(
        evaluateAutoApproval(samplePolicy, "client_onboarding", {
          companyType: "client",
          creditScore: "750" as any, // string instead of number
        }),
      ).toBe(false);
    });

    it("fails safely when numeric field is NaN", () => {
      expect(
        evaluateAutoApproval(samplePolicy, "invoice_issue", {
          amount: NaN,
          currency: "USD",
          riskTier: "low",
        }),
      ).toBe(false);
    });

    it("fails safely when payload is empty or not an object", () => {
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", {} as any)).toBe(false);
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", null as any)).toBe(false);
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", undefined as any)).toBe(false);
      expect(evaluateAutoApproval(samplePolicy, "invoice_issue", "string_payload" as any)).toBe(false);
    });

    it("fails safely when rule condition has malformed operator or non-array 'in' value", () => {
      const badPolicy: PolicyConfig = {
        autoApprovalRules: [
          {
            actionType: "invoice_issue",
            conditions: [
              { field: "amount", op: "invalid_op" as any, value: 50000 },
            ],
          },
          {
            actionType: "bad_in",
            conditions: [
              { field: "status", op: "in", value: "not-an-array" as any },
            ],
          },
        ],
      };

      expect(
        evaluateAutoApproval(badPolicy, "invoice_issue", { amount: 1000 }),
      ).toBe(false);

      expect(
        evaluateAutoApproval(badPolicy, "bad_in", { status: "active" }),
      ).toBe(false);
    });
  });
});
