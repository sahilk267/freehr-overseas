import { lockedSelect } from "./database";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { candidates, companies, consents, jobs, suppressionList } from "../../drizzle/schema";
import { hashContactValue } from "../db";

export async function assertSharingEligible(db: any, input: { ownerId: number; candidateId: string; jobId: string; companyId: string }, lock = false) {
  const query = db.select().from(candidates).where(and(eq(candidates.id, input.candidateId), eq(candidates.ownerId, input.ownerId))).limit(1);
  const candidate = (await (lock ? lockedSelect(query) : query))[0];
  if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "Candidate was not found." });
  if (candidate.deletedAt || candidate.withdrawnAt || candidate.doNotContactAt || ["deleted", "deletion_pending", "withdrawn", "do_not_contact"].includes(candidate.profileState)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Candidate is no longer eligible for sharing." });
  }
  const company = (await db.select().from(companies).where(and(eq(companies.id, input.companyId), eq(companies.ownerId, input.ownerId))).limit(1))[0];
  const job = (await db.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, input.ownerId))).limit(1))[0];
  if (!company || !job || job.companyId !== input.companyId || ["cancelled", "archived", "filled", "paused"].includes(job.pipelineState)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Client or job is no longer eligible for sharing." });
  }
  const hashes = [candidate.emailHash, candidate.phoneHash, candidate.email ? hashContactValue(candidate.email) : null].filter(Boolean) as string[];
  if (hashes.length && (await db.select().from(suppressionList).where(and(eq(suppressionList.ownerId, input.ownerId), eq(suppressionList.active, true), inArray(suppressionList.valueHash, hashes))).limit(1)).length) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Candidate contact is suppressed." });
  }
  const consentQuery = db.select().from(consents).where(and(eq(consents.ownerId, input.ownerId), eq(consents.candidateId, input.candidateId), eq(consents.companyId, input.companyId), eq(consents.jobId, input.jobId), eq(consents.consentType, "client_sharing"), eq(consents.status, "granted")));
  const granted = await (lock ? lockedSelect(consentQuery) : consentQuery);
  const consent = granted.find((c: typeof consents.$inferSelect) => !c.expiresAt || c.expiresAt > new Date());
  if (!consent) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Explicit candidate client-sharing consent is required for the current job and client." });
  return { candidate, company, job, consent };
}
