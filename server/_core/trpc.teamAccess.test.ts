import { beforeEach, describe, expect, it, vi } from "vitest";

let selectResults: unknown[][] = [];

vi.mock("../db", () => ({
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectResults.shift() ?? [] }) }) }),
  }),
}));

const { protectedProcedure, router } = await import("./trpc");

const testRouter = router({
  recruitment: router({
    jobs: router({
      create: protectedProcedure.query(({ ctx }) => ({ workspaceOwnerId: ctx.user.id, actorId: ctx.actor?.id, role: ctx.workspace?.role })),
    }),
    approvals: router({
      decide: protectedProcedure.query(() => ({ unreachable: true })),
    }),
  }),
});

describe("tRPC team workspace middleware", () => {
  const memberContext = { user: { id: 17, role: "user", email: "member@example.test" }, req: { headers: { "x-freelancehr-workspace": "44" } }, res: {} } as never;

  beforeEach(() => { selectResults = []; });

  it("runs a permitted recruiter route against the selected owner workspace while preserving the actual actor", async () => {
    selectResults = [[{ id: "tm-1", ownerId: 44, memberUserId: 17, role: "recruiter", status: "active" }]];
    const caller = testRouter.createCaller(memberContext);
    await expect(caller.recruitment.jobs.create()).resolves.toEqual({ workspaceOwnerId: 44, actorId: 17, role: "recruiter" });
  });

  it("blocks a recruiter from the owner-only approval route", async () => {
    selectResults = [[{ id: "tm-1", ownerId: 44, memberUserId: 17, role: "recruiter", status: "active" }]];
    const caller = testRouter.createCaller(memberContext);
    await expect(caller.recruitment.approvals.decide()).rejects.toThrow("not permitted");
  });

  it("blocks a non-admin user from treating their own default workspace as an owner workspace", async () => {
    const caller = testRouter.createCaller({ user: { id: 17, role: "user", email: "member@example.test" }, req: { headers: {} }, res: {} } as never);
    await expect(caller.recruitment.jobs.create()).rejects.toThrow("Activate and select");
  });

  it("blocks every non-owner route in owner-only testing mode", async () => {
    vi.stubEnv("OWNER_ONLY_MODE", "true");
    const caller = testRouter.createCaller({ user: { id: 17, role: "user", email: "member@example.test" }, req: { headers: {} }, res: {} } as never);
    await expect(caller.recruitment.jobs.create()).rejects.toThrow("owner-only testing mode");
    vi.unstubAllEnvs();
  });

  it("keeps the configured primary owner allowed in owner-only testing mode", async () => {
    vi.stubEnv("OWNER_ONLY_MODE", "true");
    vi.stubEnv("PRIMARY_OWNER_EMAIL", "owner@example.test");
    const caller = testRouter.createCaller({ user: { id: 17, role: "user", email: "owner@example.test" }, req: { headers: {} }, res: {} } as never);
    await expect(caller.recruitment.jobs.create()).resolves.toEqual({ workspaceOwnerId: 17, actorId: 17, role: "owner" });
    vi.unstubAllEnvs();
  });
});
