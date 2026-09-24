import { and, eq } from "drizzle-orm";
import type { User } from "../../drizzle/schema";
import { teamMembers } from "../../drizzle/schema";
import { requireDb } from "../db";

export type TeamRole = "owner" | "recruiter" | "coordinator" | "finance" | "viewer";

export type WorkspaceAccess = {
  ownerId: number;
  role: TeamRole;
  isOwner: boolean;
  memberId: string | null;
};

export function isOwnerOnlyMode() {
  const value = process.env.OWNER_ONLY_MODE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export { isPrimaryOwner, resolvePrimaryOwner, getConfiguredPrimaryOwner } from "./primaryOwner";
import { isPrimaryOwner } from "./primaryOwner";

export function canUseApplication(actor: Pick<User, "openId" | "email"> & { role?: string | null }) {
  return !isOwnerOnlyMode() || isPrimaryOwner(actor) || actor.role === "admin";
}

export const rolePaths: Record<Exclude<TeamRole, "owner">, readonly string[]> = {
  recruiter: [
    "operations.dashboard",
    "recruitment.prospects.list", "recruitment.prospects.create", "recruitment.prospects.transition", "recruitment.prospects.addContact",
    "recruitment.outreach.draftSequence", "recruitment.outreach.classifyInboundReply", "recruitment.outreach.list",
    "recruitment.jobs.list", "recruitment.jobs.create", "recruitment.jobs.transition",
    "recruitment.candidates.list", "recruitment.candidates.search", "recruitment.candidates.create", "recruitment.candidates.transition", "recruitment.candidates.documents.list",
    "recruitment.matching.listForJob", "recruitment.matching.createEvidenceMatch",
    "recruitment.candidateWorkflows.screenings.list", "recruitment.candidateWorkflows.screenings.create", "recruitment.candidateWorkflows.screenings.updateState",
    "recruitment.candidateWorkflows.shortlists.list", "recruitment.candidateWorkflows.shortlists.updateNote",
    "recruitment.interviews.list", "recruitment.feedback.list",
  ],
  coordinator: [
    "operations.dashboard",
    "recruitment.candidates.list", "recruitment.candidates.search", "recruitment.jobs.list",
    "recruitment.interviews.list", "recruitment.interviews.create", "recruitment.interviews.transition",
    "recruitment.feedback.list", "recruitment.feedback.record",
    "recruitment.outreach.draftSequence",
  ],
  finance: [
    "operations.dashboard",
    "recruitment.placements.list", "recruitment.invoices.list", "recruitment.invoices.draft",
    // Controlled finance approval requests: finance users can submit invoice issue and revenue
    // actions (status, dispute, credit) into the owner's review queue with evidence.
    // Decision rights (recruitment.approvals.decide / consequential.decide) remain strictly owner-only.
    "recruitment.invoices.requestIssueApproval",
    "recruitment.consequential.requestInvoiceAction",
  ],
  viewer: [
    "operations.dashboard",
    "recruitment.prospects.list", "recruitment.jobs.list", "recruitment.candidates.list", "recruitment.candidates.search",
    "recruitment.matching.listForJob", "recruitment.candidateWorkflows.screenings.list", "recruitment.candidateWorkflows.shortlists.list",
    "recruitment.interviews.list", "recruitment.feedback.list", "recruitment.placements.list", "recruitment.invoices.list",
  ],
};

const selfServicePaths = new Set(["team.accept", "team.myAccess", "team.permissions"]);

function ownerAccess(actor: User): WorkspaceAccess {
  return { ownerId: actor.id, role: "owner", isOwner: true, memberId: null };
}

export function requestedWorkspaceId(request: unknown) {
  if (!request || typeof request !== "object") return null;
  const headers = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  const value = headers?.["x-freelancehr-workspace"];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function resolveWorkspaceAccess(actor: User, requestedOwnerId: number | null): Promise<WorkspaceAccess> {
  if (!requestedOwnerId || requestedOwnerId === actor.id) return ownerAccess(actor);
  const db = await requireDb();
  const membership = (await db.select().from(teamMembers).where(and(
    eq(teamMembers.ownerId, requestedOwnerId),
    eq(teamMembers.memberUserId, actor.id),
    eq(teamMembers.status, "active"),
  )).limit(1))[0];
  if (!membership || membership.role === "owner") return ownerAccess(actor);
  return { ownerId: membership.ownerId, role: membership.role, isOwner: false, memberId: membership.id };
}

export function canAccessWorkspacePath(access: WorkspaceAccess, path: string) {
  if (access.isOwner) return true;
  if (selfServicePaths.has(path)) return true;
  if (access.role === "owner") return false;
  return rolePaths[access.role].includes(path);
}

export function allowedPathsForRole(role: TeamRole) {
  return role === "owner" ? ["*"] : rolePaths[role];
}
