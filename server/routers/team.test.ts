import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
const audits: Record<string, unknown>[] = [];
let selectResults: unknown[][] = [];

vi.mock("../../drizzle/schema", () => ({ auditEvents: {}, teamInvitations: {}, teamMembers: {} }));
vi.mock("../db", () => ({
  createId: (prefix = "") => `${prefix}unit-id`,
  recordAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
  requireDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => selectResults.shift() ?? [] }), limit: async () => selectResults.shift() ?? [] }) }) }),
    insert: () => ({ values: async (values: Record<string, unknown>) => { inserts.push(values); return undefined; } }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push(values); return undefined; } }) }),
  }),
}));

const { teamRouter } = await import("./team");

describe("team router owner controls", () => {
  const ownerCtx = { user: { id: 17, role: "admin", name: "Workspace Owner", email: "owner@example.test" }, req: {}, res: {} } as never;

  beforeEach(() => { inserts.length = 0; updates.length = 0; audits.length = 0; selectResults = []; });

  it("blocks non-owners from managing team memberships", async () => {
    const caller = teamRouter.createCaller({ user: { id: 18, role: "user", email: "member@example.test" }, req: {}, res: {} } as never);
    await expect(caller.invite({ email: "member@example.test", role: "recruiter" })).rejects.toThrow("Activate and select");
    expect(inserts).toHaveLength(0);
  });

  it("creates a hashed, expiring invitation record without attempting email delivery", async () => {
    selectResults = [[]];
    const caller = teamRouter.createCaller(ownerCtx);
    const result = await caller.invite({ email: "Member@Example.test", displayName: "Member", role: "coordinator", expiresInHours: 24 });
    expect(result.delivery).toBe("pending_hostinger_mail_activation");
    expect(result.invitationCode.length).toBeGreaterThan(24);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatchObject({ email: "member@example.test", role: "coordinator", status: "invited" });
    expect(inserts[1]).toMatchObject({ email: "member@example.test", role: "coordinator" });
    expect(inserts[1]?.tokenHash).not.toBe(result.invitationCode);
    expect(audits).toContainEqual(expect.objectContaining({ action: "team.invitation_created", ownerId: 17 }));
  });

  it("never permits an invitation to create a second workspace owner", async () => {
    const caller = teamRouter.createCaller(ownerCtx);
    await expect(caller.invite({ email: "member@example.test", role: "owner" as never })).rejects.toThrow();
    expect(inserts).toHaveLength(0);
  });

  it("marks an expired invitation safely before it can activate a membership", async () => {
    selectResults = [[{ id: "tiv-1", ownerId: 17, memberId: "tm-1", email: "member@example.test", status: "pending", expiresAt: new Date(Date.now() - 1000) }]];
    const caller = teamRouter.createCaller({ user: { id: 18, role: "user", name: "Member", email: "member@example.test" }, req: {}, res: {} } as never);
    await expect(caller.accept({ invitationCode: "abcdefghijklmnopqrstuvwx123456" })).rejects.toThrow("expired");
    expect(updates).toContainEqual(expect.objectContaining({ status: "expired" }));
    expect(audits).toHaveLength(0);
  });

  it("rejects role changes for a revoked member", async () => {
    selectResults = [[{ id: "tm-1", ownerId: 17, email: "member@example.test", role: "recruiter", status: "revoked" }]];
    const caller = teamRouter.createCaller(ownerCtx);
    await expect(caller.updateRole({ memberId: "tm-1", role: "finance" })).rejects.toThrow("revoked member");
    expect(updates).toHaveLength(0);
  });

  it("revokes membership, invalidates pending invitations, and records the owner decision", async () => {
    selectResults = [[{ id: "tm-1", ownerId: 17, email: "member@example.test", role: "recruiter", status: "active" }]];
    const caller = teamRouter.createCaller(ownerCtx);
    await expect(caller.revoke({ memberId: "tm-1", reason: "Access no longer required" })).resolves.toEqual({ success: true });
    expect(updates).toContainEqual(expect.objectContaining({ status: "revoked" }));
    expect(audits).toContainEqual(expect.objectContaining({ action: "team.member_revoked", previousState: "active", nextState: "revoked" }));
  });
});
