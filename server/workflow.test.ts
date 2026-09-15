import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { assertTransition, ensureSafeAiText, isConsequentialAction, WORKFLOW_STATES } from "./workflow";

describe("recruitment workflow controls", () => {
  it("allows valid job-state progression", () => {
    expect(() => assertTransition("job", "draft", "client_confirmation")).not.toThrow();
    expect(() => assertTransition("job", "approved", "sourcing")).not.toThrow();
  });

  it("blocks an unsafe workflow jump", () => {
    expect(() => assertTransition("job", "draft", "filled")).toThrow(TRPCError);
  });

  it("marks client sharing, onboarding, placements, and invoices as consequential", () => {
    expect(isConsequentialAction("client_onboarding")).toBe(true);
    expect(isConsequentialAction("candidate_share")).toBe(true);
    expect(isConsequentialAction("placement_confirmation")).toBe(true);
    expect(isConsequentialAction("invoice_issue")).toBe(true);
    expect(isConsequentialAction("candidate_final_decision")).toBe(true);
    expect(isConsequentialAction("invoice_dispute")).toBe(true);
    expect(isConsequentialAction("replacement_case")).toBe(true);
    expect(isConsequentialAction("draft_outreach")).toBe(false);
  });

  it("enforces controlled screening, shortlist, queue, rights, and incident progressions", () => {
    expect(() => assertTransition("screening", "in_progress", "ready_for_owner_decision")).not.toThrow();
    expect(() => assertTransition("shortlist", "prepared", "shared")).toThrow(TRPCError);
    expect(() => assertTransition("automation_job", "running", "completed")).not.toThrow();
    expect(() => assertTransition("rights_request", "received", "resolved")).not.toThrow();
    expect(() => assertTransition("incident", "detected", "contained")).not.toThrow();
  });

  it("rejects protected or prohibited prompts in recruitment AI workflows", () => {
    expect(() => ensureSafeAiText("Rank candidates by religion")).toThrow(TRPCError);
    expect(() => ensureSafeAiText("Summarize evidence of TypeScript experience")).not.toThrow();
  });

  it("starts an invoice, disputes it, credits it, and confirms the resulting state is a valid, further-transitionable state per transitions.invoice", () => {
    // 1. Starts an invoice: draft -> approval_pending -> issued
    let state = "draft";
    expect(() => assertTransition("invoice", state, "approval_pending")).not.toThrow();
    state = "approval_pending";
    expect(() => assertTransition("invoice", state, "issued")).not.toThrow();
    state = "issued";

    // 2. Disputes it: issued -> disputed
    expect(() => assertTransition("invoice", state, "disputed")).not.toThrow();
    state = "disputed";

    // 3. Credits it: disputed -> credited
    expect(() => assertTransition("invoice", state, "credited")).not.toThrow();
    state = "credited";

    // 4. Confirms the resulting state is a valid, further-transitionable state per transitions.invoice
    // (i.e. assertTransition never throws for the terminal state going forward)
    expect(WORKFLOW_STATES.invoice).toHaveProperty("credited");
    expect(WORKFLOW_STATES.invoice.credited).toContain("closed");
    expect(() => assertTransition("invoice", state, "closed")).not.toThrow();

    // Terminal state going forward: transition to closed, self-transition succeeds, invalid transitions throw
    state = "closed";
    expect(WORKFLOW_STATES.invoice).toHaveProperty("closed");
    expect(() => assertTransition("invoice", state, "closed")).not.toThrow();
    expect(() => assertTransition("invoice", state, "draft")).toThrow(TRPCError);
  });
});
