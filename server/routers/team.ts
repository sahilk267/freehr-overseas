import { and, count, desc, eq, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { auditEvents, teamInvitations, teamMembers } from "../../drizzle/schema";
import { createId, recordAudit, requireDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";

const assignableRoleSchema = z.enum(["recruiter", "coordinator", "finance", "viewer"]);

export const teamPermissionSummary = {
  owner: ["all workspace controls", "owner approvals", "team administration", "policy and audit administration"],
  recruiter: ["prepare recruitment records", "prepare outreach drafts", "request controlled approvals"],
  coordinator: ["coordinate interviews", "record operational notes", "prepare reminder drafts"],
  finance: ["prepare invoice records", "record finance evidence", "request controlled finance approvals"],
  viewer: ["read-only activity visibility after production workspace access is enabled"],
} as const;

function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function requireTeamOwner(ctx: { user: { id: number; role: string }; actor?: { id: number } | null; workspace?: { isOwner: boolean; ownerId: number } | null }) {
  const actorRole = (ctx.actor as { role?: string } | null | undefined)?.role ?? ctx.user.role;
  if (actorRole !== "admin" || !ctx.workspace?.isOwner && !(ctx.user.role === "admin" && !ctx.actor)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the workspace owner can manage team access." });
  }
  return ctx.workspace?.ownerId ?? ctx.user.id;
}

async function expireOutstandingInvitations(ownerId: number) {
  const db = await requireDb();
  await db.update(teamInvitations).set({ status: "expired" }).where(and(eq(teamInvitations.ownerId, ownerId), eq(teamInvitations.status, "pending"), lt(teamInvitations.expiresAt, new Date())));
}

export const teamRouter = router({
  permissions: protectedProcedure.query(() => teamPermissionSummary),
  overview: protectedProcedure.query(async ({ ctx }) => {
    const ownerId = requireTeamOwner(ctx);
    await expireOutstandingInvitations(ownerId);
    const db = await requireDb();
    const [members, pendingInvitations, activeMembers] = await Promise.all([
      db.select().from(teamMembers).where(eq(teamMembers.ownerId, ownerId)).orderBy(desc(teamMembers.updatedAt)),
      db.select().from(teamInvitations).where(and(eq(teamInvitations.ownerId, ownerId), eq(teamInvitations.status, "pending"))).orderBy(desc(teamInvitations.createdAt)),
      db.select({ value: count() }).from(teamMembers).where(and(eq(teamMembers.ownerId, ownerId), eq(teamMembers.status, "active"))),
    ]);
    return { members, pendingInvitations, activeMemberCount: activeMembers[0]?.value ?? 0, permissionSummary: teamPermissionSummary, inviteDelivery: "pending_hostinger_mail_activation" as const };
  }),
  invite: protectedProcedure.input(z.object({
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().min(2).max(160).optional(),
    role: assignableRoleSchema,
    expiresInHours: z.number().int().min(12).max(720).default(168),
  })).mutation(async ({ ctx, input }) => {
    const ownerId = requireTeamOwner(ctx);
    const actorId = ctx.actor?.id ?? ctx.user.id;
    await expireOutstandingInvitations(ownerId);
    const db = await requireDb();
    const email = input.email.toLowerCase();
    const existing = (await db.select().from(teamMembers).where(and(eq(teamMembers.ownerId, ownerId), eq(teamMembers.email, email))).limit(1))[0];
    if (existing && existing.status !== "revoked") {
      throw new TRPCError({ code: "CONFLICT", message: "This email already has an active or pending team membership." });
    }
    const memberId = existing?.id ?? createId("tm_");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000);
    const rawToken = randomBytes(24).toString("base64url");
    const invitationId = createId("tiv_");
    const role = input.role;
    if (existing) {
      await db.update(teamMembers).set({ displayName: input.displayName ?? existing.displayName, role, status: "invited", memberUserId: null, joinedAt: null, revokedAt: null, createdById: actorId }).where(eq(teamMembers.id, existing.id));
    } else {
      await db.insert(teamMembers).values({ id: memberId, ownerId, email, displayName: input.displayName ?? null, role, status: "invited", createdById: actorId });
    }
    await db.insert(teamInvitations).values({ id: invitationId, ownerId, memberId, email, role, tokenHash: hashInvitationToken(rawToken), expiresAt, createdById: actorId });
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "team.invitation_created", resourceType: "team_invitation", resourceId: invitationId, nextState: "pending", metadata: { memberId, email, role, expiresAt: expiresAt.toISOString(), delivery: "pending_hostinger_mail_activation" } });
    return { memberId, invitationId, expiresAt, invitationCode: rawToken, delivery: "pending_hostinger_mail_activation" as const };
  }),
  updateRole: protectedProcedure.input(z.object({ memberId: z.string().min(4), role: assignableRoleSchema })).mutation(async ({ ctx, input }) => {
    const ownerId = requireTeamOwner(ctx);
    const actorId = ctx.actor?.id ?? ctx.user.id;
    const db = await requireDb();
    const member = (await db.select().from(teamMembers).where(and(eq(teamMembers.id, input.memberId), eq(teamMembers.ownerId, ownerId))).limit(1))[0];
    if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Team member was not found." });
    if (member.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A revoked member must receive a new invitation instead of a role change." });
    await db.update(teamMembers).set({ role: input.role }).where(eq(teamMembers.id, member.id));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "team.role_updated", resourceType: "team_member", resourceId: member.id, previousState: member.role, nextState: input.role, metadata: { email: member.email } });
    return { success: true };
  }),
  revoke: protectedProcedure.input(z.object({ memberId: z.string().min(4), reason: z.string().trim().min(3).max(1000) })).mutation(async ({ ctx, input }) => {
    const ownerId = requireTeamOwner(ctx);
    const actorId = ctx.actor?.id ?? ctx.user.id;
    const db = await requireDb();
    const member = (await db.select().from(teamMembers).where(and(eq(teamMembers.id, input.memberId), eq(teamMembers.ownerId, ownerId))).limit(1))[0];
    if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Team member was not found." });
    if (member.role === "owner") throw new TRPCError({ code: "FORBIDDEN", message: "The workspace owner cannot be revoked through team controls." });
    if (member.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This membership has already been revoked." });
    const now = new Date();
    await db.update(teamMembers).set({ status: "revoked", revokedAt: now }).where(eq(teamMembers.id, member.id));
    await db.update(teamInvitations).set({ status: "revoked", revokedAt: now }).where(and(eq(teamInvitations.memberId, member.id), eq(teamInvitations.status, "pending")));
    await recordAudit({ ownerId, actorType: "user", actorId: String(actorId), action: "team.member_revoked", resourceType: "team_member", resourceId: member.id, previousState: member.status, nextState: "revoked", metadata: { email: member.email, reason: input.reason } });
    return { success: true };
  }),
  accept: protectedProcedure.input(z.object({ invitationCode: z.string().trim().min(24).max(128) })).mutation(async ({ ctx, input }) => {
    const actor = ctx.actor ?? ctx.user;
    const email = actor.email?.trim().toLowerCase();
    if (!email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your signed-in identity must include an email address before a team invitation can be accepted." });
    const db = await requireDb();
    const invitation = (await db.select().from(teamInvitations).where(eq(teamInvitations.tokenHash, hashInvitationToken(input.invitationCode))).limit(1))[0];
    if (!invitation || invitation.status !== "pending") throw new TRPCError({ code: "NOT_FOUND", message: "The invitation is invalid, expired, or no longer available." });
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await db.update(teamInvitations).set({ status: "expired" }).where(eq(teamInvitations.id, invitation.id));
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This invitation has expired. Ask the workspace owner to issue a new invitation." });
    }
    if (invitation.email !== email) throw new TRPCError({ code: "FORBIDDEN", message: "Sign in with the same email address that received this invitation." });
    const member = (await db.select().from(teamMembers).where(and(eq(teamMembers.id, invitation.memberId), eq(teamMembers.ownerId, invitation.ownerId))).limit(1))[0];
    if (!member || member.status !== "invited") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The related team membership is not ready for activation." });
    const now = new Date();
    await db.update(teamMembers).set({ memberUserId: actor.id, displayName: member.displayName ?? actor.name ?? null, status: "active", joinedAt: now }).where(eq(teamMembers.id, member.id));
    await db.update(teamInvitations).set({ status: "accepted", acceptedAt: now }).where(eq(teamInvitations.id, invitation.id));
    await recordAudit({ ownerId: invitation.ownerId, actorType: "user", actorId: String(actor.id), action: "team.invitation_accepted", resourceType: "team_member", resourceId: member.id, previousState: "invited", nextState: "active", metadata: { role: member.role, email } });
    return { success: true, role: member.role, ownerId: invitation.ownerId };
  }),
  myAccess: protectedProcedure.query(async ({ ctx }) => {
    const actor = ctx.actor ?? ctx.user;
    const email = actor.email?.trim().toLowerCase();
    if (!email) return null;
    const db = await requireDb();
    const membership = (await db.select().from(teamMembers).where(and(eq(teamMembers.memberUserId, actor.id), eq(teamMembers.email, email), eq(teamMembers.status, "active"))).limit(1))[0];
    if (!membership) return null;
    return { ownerId: membership.ownerId, memberId: membership.id, role: membership.role, permissions: teamPermissionSummary[membership.role] };
  }),
  activity: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).default({ limit: 30 })).query(async ({ ctx, input }) => {
    const ownerId = requireTeamOwner(ctx);
    const db = await requireDb();
    const events = await db.select().from(auditEvents).where(eq(auditEvents.ownerId, ownerId)).orderBy(desc(auditEvents.createdAt)).limit(input.limit);
    return events.filter(event => event.action.startsWith("team."));
  }),
});
