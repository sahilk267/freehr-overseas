import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  auditEvents,
  candidateDocuments,
  candidates,
  companies,
  consents,
  interviews,
  jobs,
  matches,
  placements,
  rightsRequests,
  shortlists,
  suppressionList,
} from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { appRouter } from "../routers";
import { assertTransition } from "../workflow";

describe("candidate privacy deletion workflow & cascade controls", () => {
  const testOwnerId = 1;
  const ownerCtx = {
    user: { id: testOwnerId, role: "admin", name: "Lead Partner", email: "partner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = appRouter.createCaller(ownerCtx);

  it("deleting a candidate who has an active interview, placement, shortlist, and match correctly closes those records and creates suppression + audit entries", async () => {
    const db = await requireDb();

    // 1. Seed company & job
    const companyId = createId("cmp_");
    await db.insert(companies).values({
      id: companyId,
      ownerId: testOwnerId,
      name: "Acme Cloud Corp",
      legalName: "Acme Cloud Technologies Pvt Ltd",
    });

    const jobId = createId("job_");
    await db.insert(jobs).values({
      id: jobId,
      ownerId: testOwnerId,
      companyId,
      title: "Lead Infrastructure Architect",
      employmentType: "full_time",
    });

    // 2. Seed active candidate with contact hashes
    const candidateId = createId("cnd_");
    const rawEmail = `candidate.${Date.now()}@domain.example`;
    const rawPhone = "+919876543210";
    const emailHash = createHash("sha256").update(rawEmail.toLowerCase().trim()).digest("hex");
    const phoneHash = createHash("sha256").update(rawPhone.trim()).digest("hex");

    await db.insert(candidates).values({
      id: candidateId,
      ownerId: testOwnerId,
      fullName: "Maya Sen",
      email: rawEmail,
      emailHash,
      phone: rawPhone,
      phoneHash,
      headline: "Distributed Systems & Cloud Architect",
      location: "Bengaluru, India",
      availability: "Immediate",
      profileState: "interview",
      sourceType: "sourced",
    });

    // 3. Seed active interview, placement, shortlist, match, and consent
    const interviewId = createId("int_");
    await db.insert(interviews).values({
      id: interviewId,
      ownerId: testOwnerId,
      companyId,
      candidateId,
      jobId,
      status: "scheduled",
      calendarStatus: "confirmed",
      scheduledAt: new Date(Date.now() + 86400000),
    });

    const placementId = createId("plc_");
    await db.insert(placements).values({
      id: placementId,
      ownerId: testOwnerId,
      companyId,
      candidateId,
      jobId,
      status: "offer_pending",
      annualCompensation: 3200000,
    });

    const shortlistId = createId("shl_");
    await db.insert(shortlists).values({
      id: shortlistId,
      ownerId: testOwnerId,
      companyId,
      jobId,
      candidateId,
      status: "prepared",
    });

    const matchId = createId("mat_");
    await db.insert(matches).values({
      id: matchId,
      ownerId: testOwnerId,
      candidateId,
      jobId,
      status: "evidence_validated",
      ruleScore: 88,
      semanticScore: 92,
      confidence: 90,
    });

    const consentId = createId("cns_");
    await db.insert(consents).values({
      id: consentId,
      ownerId: testOwnerId,
      candidateId,
      jobId,
      companyId,
      consentType: "platform_processing",
      status: "granted",
      noticeVersion: "1.0",
      grantedAt: new Date(),
    });

    const docId = createId("doc_");
    await db.insert(candidateDocuments).values({
      id: docId,
      ownerId: testOwnerId,
      candidateId,
      documentType: "cv",
      storageKey: `local/private/${testOwnerId}/candidates/${candidateId}/cv.pdf`,
      storageUrl: `/api/private-storage/cv.pdf`,
      originalName: "Maya_Sen_Resume.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      scanState: "clean",
      parseState: "parsed",
    });

    // 4. Create an erasure / deletion rights request
    const requestId = createId("rgt_");
    await db.insert(rightsRequests).values({
      id: requestId,
      ownerId: testOwnerId,
      candidateId,
      requestType: "deletion",
      status: "received",
      details: "Statutory right to erasure request received from candidate.",
    });

    // 5. Fulfill deletion
    const result = await caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote: "Right to erasure fulfilled per GDPR Art 17 & DPDP Sec 12; PII redacted and contacts suppressed.",
    });
    expect(result.success).toBe(true);

    // 6. Verify Candidate is wiped and profileState is 'deleted'
    const [deletedCandidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(deletedCandidate.profileState).toBe("deleted");
    expect(deletedCandidate.fullName).toBe("Deleted candidate");
    expect(deletedCandidate.email).toBeNull();
    expect(deletedCandidate.emailHash).toBeNull();
    expect(deletedCandidate.phone).toBeNull();
    expect(deletedCandidate.phoneHash).toBeNull();
    expect(deletedCandidate.headline).toBeNull();
    expect(deletedCandidate.location).toBeNull();
    expect(deletedCandidate.availability).toBeNull();
    expect(deletedCandidate.deletedAt).toBeInstanceOf(Date);

    // 7. Verify Interview was cancelled and calendarStatus is cancelled
    const [updatedInterview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(updatedInterview.status).toBe("cancelled");
    expect(updatedInterview.calendarStatus).toBe("cancelled");

    // 8. Verify Placement was closed
    const [updatedPlacement] = await db.select().from(placements).where(eq(placements.id, placementId));
    expect(updatedPlacement.status).toBe("closed");

    // 9. Verify Shortlist was withdrawn
    const [updatedShortlist] = await db.select().from(shortlists).where(eq(shortlists.id, shortlistId));
    expect(updatedShortlist.status).toBe("withdrawn");

    // 10. Verify Match was closed
    const [updatedMatch] = await db.select().from(matches).where(eq(matches.id, matchId));
    expect(updatedMatch.status).toBe("closed");

    // 11. Verify Consent was marked withdrawn
    const [updatedConsent] = await db.select().from(consents).where(eq(consents.id, consentId));
    expect(updatedConsent.status).toBe("withdrawn");

    // 12. Verify Suppression List entries exist for both email and phone hashes
    const suppressionRecords = await db
      .select()
      .from(suppressionList)
      .where(and(eq(suppressionList.ownerId, testOwnerId), eq(suppressionList.active, true)));

    const emailSuppressed = suppressionRecords.find(s => s.channel === "email" && s.valueHash === emailHash);
    const phoneSuppressed = suppressionRecords.find(s => s.channel === "phone" && s.valueHash === phoneHash);

    expect(emailSuppressed).toBeDefined();
    expect(emailSuppressed?.source).toBe("candidate_rights");
    expect(emailSuppressed?.reason).toContain("Right to erasure fulfilled");

    expect(phoneSuppressed).toBeDefined();
    expect(phoneSuppressed?.source).toBe("candidate_rights");
    expect(phoneSuppressed?.reason).toContain("Right to erasure fulfilled");

    // 13. Verify Audit Log entries were created for the deletion and cascaded transitions
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.ownerId, testOwnerId));

    const candidateDeletedAudit = audits.find(
      a => a.action === "candidate.deleted" && a.resourceId === candidateId
    );
    expect(candidateDeletedAudit).toBeDefined();
    expect(candidateDeletedAudit?.nextState).toBe("deleted");

    const privacyResolvedAudit = audits.find(
      a => a.action === "privacy.deletion_fulfilled" && a.resourceId === requestId
    );
    expect(privacyResolvedAudit).toBeDefined();
    expect(privacyResolvedAudit?.nextState).toBe("resolved");

    const interviewAudit = audits.find(
      a => a.action === "interview.state_changed" && a.resourceId === interviewId
    );
    expect(interviewAudit).toBeDefined();
    expect(interviewAudit?.nextState).toBe("cancelled");

    const placementAudit = audits.find(
      a => a.action === "placement.state_changed" && a.resourceId === placementId
    );
    expect(placementAudit).toBeDefined();
    expect(placementAudit?.nextState).toBe("closed");

    const shortlistAudit = audits.find(
      a => a.action === "shortlist.state_changed" && a.resourceId === shortlistId
    );
    expect(shortlistAudit).toBeDefined();
    expect(shortlistAudit?.nextState).toBe("withdrawn");

    const matchAudit = audits.find(
      a => a.action === "match.state_changed" && a.resourceId === matchId
    );
    expect(matchAudit).toBeDefined();
    expect(matchAudit?.nextState).toBe("closed");

    // 14. Verify Rights Request is marked resolved
    const [updatedRequest] = await db.select().from(rightsRequests).where(eq(rightsRequests.id, requestId));
    expect(updatedRequest.status).toBe("resolved");
    expect(updatedRequest.resolvedAt).toBeInstanceOf(Date);
    expect(updatedRequest.details).toContain("Resolution: Right to erasure fulfilled");

    // 15. Verify candidate document was redacted and document audit logged
    const [updatedDoc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, docId));
    expect(updatedDoc.scanState).toBe("redacted");
    expect(updatedDoc.parseState).toBe("redacted");
    expect(updatedDoc.originalName).toBe("redacted.bin");
    expect(updatedDoc.storageUrl).toBe("");

    const docAudit = audits.find(a => a.action === "document.deleted" && a.resourceId === docId);
    expect(docAudit).toBeDefined();
    expect(docAudit?.nextState).toBe("redacted");
  });

  it("gracefully transitions completed interview to 'closed' during cascade", async () => {
    const db = await requireDb();

    const candidateId = createId("cnd_");
    await db.insert(candidates).values({
      id: candidateId,
      ownerId: testOwnerId,
      fullName: "Completed Interview Candidate",
      profileState: "available",
      sourceType: "manual",
    });

    const companyId = createId("cmp_");
    await db.insert(companies).values({
      id: companyId,
      ownerId: testOwnerId,
      name: "Beta Corp",
      legalName: "Beta Corp India Ltd",
    });

    const jobId = createId("job_");
    await db.insert(jobs).values({
      id: jobId,
      ownerId: testOwnerId,
      companyId,
      title: "QA Engineer",
      employmentType: "full_time",
    });

    const interviewId = createId("int_");
    await db.insert(interviews).values({
      id: interviewId,
      ownerId: testOwnerId,
      companyId,
      candidateId,
      jobId,
      status: "completed",
    });

    const requestId = createId("rgt_");
    await db.insert(rightsRequests).values({
      id: requestId,
      ownerId: testOwnerId,
      candidateId,
      requestType: "deletion",
      status: "received",
      details: "Erasure request",
    });

    await caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
      requestId,
      resolutionNote: "Fulfilled erasure for completed candidate",
    });

    const [updatedInterview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(updatedInterview.status).toBe("closed");
  });

  it("rejects deletion if request is not received or not deletion type", async () => {
    const db = await requireDb();

    const candidateId = createId("cnd_");
    await db.insert(candidates).values({
      id: candidateId,
      ownerId: testOwnerId,
      fullName: "Correction Candidate",
      profileState: "available",
    });

    const correctionReqId = createId("rgt_");
    await db.insert(rightsRequests).values({
      id: correctionReqId,
      ownerId: testOwnerId,
      candidateId,
      requestType: "correction",
      status: "received",
      details: "Correction note",
    });

    await expect(
      caller.recruitment.candidateWorkflows.privacy.fulfillDeletion({
        requestId: correctionReqId,
        resolutionNote: "Invalid attempt to delete via correction",
      })
    ).rejects.toThrow(TRPCError);
  });
});
