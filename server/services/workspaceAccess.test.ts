import { beforeEach, describe, expect, it, vi } from "vitest";

let selectResults: unknown[][] = [];

vi.mock("../db", () => ({
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectResults.shift() ?? [] }) }) }),
  }),
}));

const { canAccessWorkspacePath, canUseApplication, isOwnerOnlyMode, isPrimaryOwner, requestedWorkspaceId, resolveWorkspaceAccess } = await import("./workspaceAccess");

describe("workspace team access", () => {
  beforeEach(() => { selectResults = []; });

  it("parses owner-only testing mode without enabling it by default", () => {
    vi.stubEnv("OWNER_ONLY_MODE", "true");
    expect(isOwnerOnlyMode()).toBe(true);
    vi.stubEnv("OWNER_ONLY_MODE", "false");
    expect(isOwnerOnlyMode()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("allows only the configured primary owner in owner-only mode", () => {
    vi.stubEnv("OWNER_ONLY_MODE", "true");
    vi.stubEnv("PRIMARY_OWNER_EMAIL", "owner@example.com");
    expect(canUseApplication({ openId: "owner", email: "owner@example.com" })).toBe(true);
    expect(canUseApplication({ openId: "member", email: "member@example.com" })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("recognizes the configured primary owner by Open ID", () => {
    vi.stubEnv("OWNER_OPEN_ID", "owner-open-id");
    expect(isPrimaryOwner({ openId: "owner-open-id", email: "owner@example.com" })).toBe(true);
    expect(isPrimaryOwner({ openId: "other-open-id", email: "owner@example.com" })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("recognizes the production primary owner by normalized email", () => {
    vi.stubEnv("OWNER_OPEN_ID", "");
    vi.stubEnv("PRIMARY_OWNER_EMAIL", "Owner@Example.com");
    expect(isPrimaryOwner({ openId: "oidc-owner", email: " owner@example.COM " })).toBe(true);
    expect(isPrimaryOwner({ openId: "oidc-other", email: "other@example.com" })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("keeps the signed-in user's own workspace as the default", async () => {
    await expect(resolveWorkspaceAccess({ id: 17 } as never, null)).resolves.toEqual({ ownerId: 17, role: "owner", isOwner: true, memberId: null });
  });

  it("resolves only a current active membership for an explicitly selected workspace", async () => {
    selectResults = [[{ id: "tm-1", ownerId: 44, memberUserId: 17, role: "finance", status: "active" }]];
    await expect(resolveWorkspaceAccess({ id: 17 } as never, 44)).resolves.toEqual({ ownerId: 44, role: "finance", isOwner: false, memberId: "tm-1" });
  });

  it("does not expose a requested workspace when no active membership exists", async () => {
    selectResults = [[]];
    await expect(resolveWorkspaceAccess({ id: 17 } as never, 44)).resolves.toEqual({ ownerId: 17, role: "owner", isOwner: true, memberId: null });
  });

  it("accepts only a bounded numeric active-workspace request header", () => {
    expect(requestedWorkspaceId({ headers: { "x-freelancehr-workspace": "44" } })).toBe(44);
    expect(requestedWorkspaceId({ headers: { "x-freelancehr-workspace": "44 or 1=1" } })).toBeNull();
    expect(requestedWorkspaceId({ headers: { "x-freelancehr-workspace": "0" } })).toBeNull();
  });

  it("permits recruiter preparation work but blocks client sharing and email delivery", () => {
    const access = { ownerId: 44, role: "recruiter" as const, isOwner: false, memberId: "tm-1" };
    expect(canAccessWorkspacePath(access, "recruitment.jobs.create")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.matching.requestShareApproval")).toBe(false);
    expect(canAccessWorkspacePath(access, "email.outbound.deliverApproved")).toBe(false);
  });

  it("permits coordinator interview operations but blocks finance and approvals", () => {
    const access = { ownerId: 44, role: "coordinator" as const, isOwner: false, memberId: "tm-1" };
    expect(canAccessWorkspacePath(access, "recruitment.interviews.create")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.invoices.draft")).toBe(false);
    expect(canAccessWorkspacePath(access, "recruitment.approvals.decide")).toBe(false);
  });

  it("permits finance invoice preparation and controlled approval requests but blocks external sends and owner decisions", () => {
    const access = { ownerId: 44, role: "finance" as const, isOwner: false, memberId: "tm-1" };
    expect(canAccessWorkspacePath(access, "recruitment.invoices.draft")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.invoices.requestIssueApproval")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.consequential.requestInvoiceAction")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.approvals.decide")).toBe(false);
    expect(canAccessWorkspacePath(access, "recruitment.consequential.decide")).toBe(false);
    expect(canAccessWorkspacePath(access, "email.outbound.requestApproval")).toBe(false);
  });

  it("keeps the viewer read-only", () => {
    const access = { ownerId: 44, role: "viewer" as const, isOwner: false, memberId: "tm-1" };
    expect(canAccessWorkspacePath(access, "recruitment.candidates.list")).toBe(true);
    expect(canAccessWorkspacePath(access, "recruitment.candidates.create")).toBe(false);
    expect(canAccessWorkspacePath(access, "team.myAccess")).toBe(true);
  });

  it("allows the owner full workspace control", () => {
    expect(canAccessWorkspacePath({ ownerId: 17, role: "owner", isOwner: true, memberId: null }, "consequential.decide")).toBe(true);
  });

  it("asserts every procedure path in every rolePaths array corresponds to a real registered path on appRouter", async () => {
    const { appRouter } = await import("../routers");
    const { rolePaths } = await import("./workspaceAccess");

    const registeredProcedures = new Set(Object.keys(appRouter._def.procedures));
    expect(registeredProcedures.size).toBeGreaterThan(0);

    const invalidPaths: Array<{ role: string; path: string }> = [];

    for (const [role, paths] of Object.entries(rolePaths)) {
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        if (!registeredProcedures.has(path)) {
          invalidPaths.push({ role, path });
        }
      }
    }

    expect(
      invalidPaths,
      `Detected rolePaths configured for non-existent tRPC procedures:\n${invalidPaths
        .map(p => ` - [${p.role}] "${p.path}"`)
        .join("\n")}`
    ).toEqual([]);
  });
});
