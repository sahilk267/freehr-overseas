import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  createId: (prefix = "") => `${prefix}unit-id`,
  recordAudit: async () => undefined,
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "tm-1", ownerId: 44, memberUserId: 17, role: "recruiter", status: "active" }] }) }) }),
  }),
}));

const { router } = await import("../_core/trpc");
const { consequentialRouter } = await import("./consequential");

const testRouter = router({ recruitment: router({ consequential: consequentialRouter }) });

describe("owner-only consequential route team denial", () => {
  it("blocks an activated recruiter before a real candidate-final-decision procedure can query or create records", async () => {
    const caller = testRouter.createCaller({
      user: { id: 17, role: "user", email: "recruiter@example.test" },
      req: { headers: { "x-freelancehr-workspace": "44" } },
      res: {},
    } as never);

    await expect(caller.recruitment.consequential.requestCandidateDecision({
      candidateId: "candidate-1",
      jobId: "job-1",
      disposition: "advance",
      evidence: ["Relevant experience is documented."],
      rationale: "Prepare this evidence for an owner review decision.",
    })).rejects.toThrow("not permitted");
  });
});
