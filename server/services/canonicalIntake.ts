import { and, eq, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { candidates, companies, contacts, suppressionList } from "../../drizzle/schema";
import { createId, hashContactValue } from "../db";
import { lockedSelect } from "./database";
import { appendWorkflowEvent } from "./workflowStore";

export function normalizeCompanyDomain(value?: string | null) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (url.username || url.password || url.port || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}$/.test(domain) || domain.length > 255) throw Error();
    return domain;
  } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid company domain without credentials or a port." }); }
}

export function normalizeIntakePhone(value?: string | null) {
  const phone = value?.trim();
  if (!phone) return null;
  const international = phone.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : phone;
}

type CandidateInput = { fullName?: string; email?: string; phone?: string; headline?: string; location?: string; availability?: string; sourceType?: string; sourceUrl?: string };
type ProspectInput = { name?: string; domain?: string; sector?: string; location?: string; sourceType?: string; sourceUrl?: string; hiringSignal?: string; confidence?: number; notes?: string };
type ContactInput = { companyId?: string; name?: string; title?: string; email?: string; phone?: string; sourceUrl?: string };

export async function assertIntakeNotSuppressed(tx: any, ownerId: number, email?: string | null, phone?: string | null) {
  for (const [channel, value] of [["email", email], ["phone", phone]] as const) {
    if (!value) continue;
    const row = (await tx.select().from(suppressionList).where(and(eq(suppressionList.ownerId, ownerId), eq(suppressionList.channel, channel), eq(suppressionList.valueHash, hashContactValue(value)), eq(suppressionList.active, true))).limit(1))[0];
    if (row) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This identity is suppressed. Import cannot reactivate a withdrawn or erased person." });
  }
}

export async function findCandidateIdentity(tx: any, ownerId: number, input: CandidateInput) {
  const email = input.email?.trim().toLowerCase() || null, phone = normalizeIntakePhone(input.phone);
  await assertIntakeNotSuppressed(tx, ownerId, email, phone);
  const identities = [...(email ? [eq(candidates.emailHash, hashContactValue(email)), eq(candidates.email, email)] : []), ...(phone ? [eq(candidates.phoneHash, hashContactValue(phone)), eq(candidates.phone, phone)] : [])];
  const rows: Array<typeof candidates.$inferSelect> = identities.length ? await lockedSelect(tx.select().from(candidates).where(and(eq(candidates.ownerId, ownerId), or(...identities))).limit(3)) : [];
  if (rows.length > 1) throw new TRPCError({ code: "CONFLICT", message: "Identity evidence matches multiple existing candidates. Resolve the conflict before importing." });
  const existing = rows[0];
  if (existing && (existing.deletedAt || existing.withdrawnAt || existing.doNotContactAt || ["deleted", "deletion_pending", "withdrawn", "do_not_contact"].includes(existing.profileState))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The existing candidate is withdrawn, erased or unavailable for contact." });
  if (existing && ((email && existing.email && email !== existing.email.trim().toLowerCase()) || (phone && existing.phone && phone !== normalizeIntakePhone(existing.phone)))) throw new TRPCError({ code: "CONFLICT", message: "Email and phone evidence disagree with the existing candidate. Review the identity instead of merging automatically." });
  return { email, phone, existing };
}

export async function intakeCandidateInTransaction(tx: any, ownerId: number, input: CandidateInput) {
  const { email, phone, existing } = await findCandidateIdentity(tx, ownerId, input);
  if (existing) return { id: existing.id, alreadyExists: true };
  const id = createId("can_");
  await tx.insert(candidates).values({ id, ownerId, fullName: input.fullName!, email, emailHash: email ? hashContactValue(email) : null, phone, phoneHash: phone ? hashContactValue(phone) : null, headline: input.headline ?? null, location: input.location ?? null, availability: input.availability ?? null, sourceType: input.sourceType ?? "manual", sourceUrl: input.sourceUrl ?? null, sourceCollectedAt: new Date(), profileState: "consent_pending" });
  await appendWorkflowEvent(tx, ownerId, "candidate.intake_created", id, 1, { sourceType: input.sourceType ?? "manual" });
  return { id, alreadyExists: false };
}

export async function findProspectIdentity(tx: any, ownerId: number, input: ProspectInput) {
  const domain = normalizeCompanyDomain(input.domain);
  const rows: Array<typeof companies.$inferSelect> = domain ? await lockedSelect(tx.select().from(companies).where(and(eq(companies.ownerId, ownerId), eq(companies.domain, domain))).limit(3)) : [];
  if (rows.length > 1) throw new TRPCError({ code: "CONFLICT", message: "This domain matches multiple existing companies. Resolve the duplicate companies first." });
  return { domain, existing: rows[0] };
}

export async function intakeProspectInTransaction(tx: any, ownerId: number, input: ProspectInput) {
  const { domain, existing } = await findProspectIdentity(tx, ownerId, input);
  if (existing) return { id: existing.id, alreadyExists: true };
  const id = createId("cmp_");
  await tx.insert(companies).values({ id, ownerId, name: input.name!, domain, sector: input.sector ?? null, location: input.location ?? null, sourceType: input.sourceType ?? "manual", sourceUrl: input.sourceUrl ?? null, sourceCollectedAt: new Date(), hiringSignal: input.hiringSignal ?? null, confidence: input.confidence ?? 0, pipelineState: "new", companyType: "prospect", verificationState: "pending", notes: input.notes ?? null });
  await appendWorkflowEvent(tx, ownerId, "company.intake_created", id, 1, { sourceType: input.sourceType ?? "manual" });
  return { id, alreadyExists: false };
}

export async function intakeContactInTransaction(tx: any, ownerId: number, input: ContactInput) {
  const company = (await tx.select().from(companies).where(and(eq(companies.ownerId, ownerId), eq(companies.id, input.companyId!))).limit(1))[0];
  if (!company) throw new TRPCError({ code: "NOT_FOUND", message: "Owned company was not found." });
  const { email, phone, existing } = await findContactIdentity(tx, ownerId, input);
  if (existing) return { id: existing.id, alreadyExists: true };
  const id = createId("con_");
  await tx.insert(contacts).values({ id, ownerId, companyId: input.companyId!, name: input.name!, title: input.title ?? null, email, phone, sourceUrl: input.sourceUrl ?? null, sourceType: input.sourceUrl ? "sourced" : "manual", contactPermission: "unknown" });
  await appendWorkflowEvent(tx, ownerId, "contact.intake_created", id, 1, { companyId: input.companyId });
  return { id, alreadyExists: false };
}

export async function findContactIdentity(tx: any, ownerId: number, input: ContactInput) {
  const email = input.email?.trim().toLowerCase() || null, phone = normalizeIntakePhone(input.phone);
  await assertIntakeNotSuppressed(tx, ownerId, email, phone);
  const identities = [...(email ? [eq(contacts.email, email)] : []), ...(phone ? [eq(contacts.phone, phone)] : [])];
  const existing: Array<typeof contacts.$inferSelect> = identities.length ? await lockedSelect(tx.select().from(contacts).where(and(eq(contacts.ownerId, ownerId), or(...identities))).limit(3)) : [];
  if (existing.length > 1 || (existing[0] && existing[0].companyId !== input.companyId)) throw new TRPCError({ code: "CONFLICT", message: "Contact identity belongs to conflicting records or another company. Review it first." });
  if (existing[0]) {
    if (existing[0].optedOutAt || existing[0].contactPermission === "opted_out") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This contact has opted out." });
    if ((email && existing[0].email && email !== existing[0].email.trim().toLowerCase()) || (phone && existing[0].phone && phone !== normalizeIntakePhone(existing[0].phone))) throw new TRPCError({ code: "CONFLICT", message: "Contact email and phone evidence disagree. Review the identity instead of merging automatically." });
  }
  return { email, phone, existing: existing[0] };
}

