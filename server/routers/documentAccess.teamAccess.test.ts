import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  createId: (prefix = "") => `${prefix}unit-id`,
  ensureWorkspace: vi.fn(),
  hashContactValue: vi.fn(),
  recordAudit: vi.fn(),
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "tm-1", ownerId: 44, memberUserId: 17, role: "recruiter", status: "active" }] }) }) }),
  }),
}));
vi.mock("../storage", () => ({ storagePut: vi.fn(), storageGetSignedUrl: vi.fn() }));

const { router } = await import("../_core/trpc");
const { recruitmentRouter } = await import("./recruitment");
const testRouter = router({ recruitment: recruitmentRouter });

describe("private candidate document team boundary", () => {
  it("blocks a recruiter team member before the signed-document access procedure can resolve document storage", async () => {
    const caller = testRouter.createCaller({ user: { id: 17, role: "user", email: "recruiter@example.test" }, req: { headers: { "x-freelancehr-workspace": "44" } }, res: {} } as never);
    await expect(caller.recruitment.candidates.documents.access({ documentId: "doc-1" })).rejects.toThrow("not permitted");
  });
});
