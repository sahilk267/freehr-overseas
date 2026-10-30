import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { appRouter } from "./routers";
import { createId, ensureWorkspace, requireDb } from "./db";
import { approvals, automationQueue, candidateDocuments, conversations, emailIdentities, invoices, payments, screenings, shortlists, users, aiUsage, candidates, workspaceSettings, messages } from "../drizzle/schema";
import { buildFastifyServer } from "./hostinger";
import { createCalendarSubscriptionToken } from "./services/calendarFeed";
import { createInterviewIcs } from "./services/calendar";
import { isPrimaryOwner } from "./services/primaryOwner";
import { processOneQueuedJob } from "./services/queue";
import { rm } from "node:fs/promises";

const send = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: "sandbox-provider-id" })));
vi.mock("./services/hostingerMail", async original => ({ ...await original(), sendViaHostingerMailApi: send, isSenderIdentityConfigured: () => true }));
const infer = vi.hoisted(() => vi.fn(async () => ({ result: { headline: "TypeScript engineer", skills: ["TypeScript"], totalExperienceYears: 6, recentRoles: [], education: [], missingInformation: [], confidence: 90 }, selectedModel: "test-model", latencyMs: 1 })));
vi.mock("./services/aiRouting", () => ({ runControlledAiTask: infer }));

const ownerId = 1000000 + Math.floor(Math.random() * 1000000000);
const caller = appRouter.createCaller({ user: { id: ownerId, openId: `w0_owner_${ownerId}`, email: "owner@example.test", role: "admin" }, req: { headers: {} }, res: {} } as never);

async function fixture() {
  const company = await caller.recruitment.prospects.create({ name: "W0 company", sourceType: "manual" });
  const job = await caller.recruitment.jobs.create({ companyId: company.id, title: "TypeScript engineer", description: "Build reliable APIs", mustHaveSkills: ["TypeScript"], compensationMin: 100000, experienceMinYears: 5 });
  const candidate = await caller.recruitment.candidates.create({ fullName: "W0 candidate", email: `${createId("candidate_")}@example.test`, headline: "Backend engineer" });
  await caller.recruitment.candidates.grantConsent({ candidateId: candidate.id, consentType: "client_sharing", companyId: company.id, jobId: job.id });
  return { company, job, candidate };
}

describe("W0 correctness regressions (also executable against disposable MySQL)", () => {
  let db: any;
  beforeAll(async () => {
    vi.stubEnv("OWNER_ONLY_MODE", "false");
    vi.stubEnv("AUTH_MODE", "");
    vi.stubEnv("JWT_SECRET", "w0-calendar-signing-key-32-characters-long");
    vi.stubEnv("PRIVATE_STORAGE_MODE", "local");
    vi.stubEnv("PRIVATE_LOCAL_STORAGE_PATH", `/tmp/freehr-w0-${process.pid}`);
    db = await requireDb();
    await db.insert(users).values({ id: ownerId, openId: `w0_owner_${ownerId}`, email: "owner@example.test", role: "admin" }).onDuplicateKeyUpdate({ set: { role: "admin" } });
    await ensureWorkspace(ownerId);
    await db.update(workspaceSettings).set({ quietHoursStart: "00:00", quietHoursEnd: "00:00", dailyOutboundLimit: 20, businessTimezone: "UTC" }).where(eq(workspaceSettings.ownerId, ownerId));
    await db.update(automationQueue).set({ status: "cancelled" }).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.status, "queued")));
  });
  afterAll(async () => { await rm(`/tmp/freehr-w0-${process.pid}`, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it("rejects anonymous, wrong-owner and expired-token calendar access and omits internal notes", async () => {
    const { company, job, candidate } = await fixture();
    await caller.recruitment.interviews.create({ companyId: company.id, jobId: job.id, candidateId: candidate.id, scheduledAt: new Date(Date.now() + 86400000), durationMinutes: 30 });
    const app = await buildFastifyServer({ logger: false });
    try {
      expect((await app.inject({ method: "GET", url: `/api/calendar/feed/${ownerId}` })).statusCode).toBe(401);
      const token = await createCalendarSubscriptionToken(ownerId);
      expect((await app.inject({ method: "GET", url: `/api/calendar/feed/${ownerId + 1}?token=${token}` })).statusCode).toBe(401);
      const expired = await new SignJWT({ scope: "calendar:read" }).setProtectedHeader({ alg: "HS256" }).setSubject(String(ownerId)).setAudience("freelancehr-calendar").setExpirationTime(1).sign(new TextEncoder().encode(process.env.SESSION_SECRET || process.env.JWT_SECRET));
      expect((await app.inject({ method: "GET", url: `/api/calendar/feed/${ownerId}?token=${expired}` })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: `/api/calendar/feed/${ownerId}?token=${token}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("BEGIN:VEVENT");
      expect(response.body).not.toContain("preparationNotes");
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally { await app.close(); }
  });

  it("folds Unicode calendar lines without corrupting text or exceeding 75 octets", () => {
    const summary = "Recruitment परिचय " .repeat(20);
    const ics = createInterviewIcs({ uid: "w0", sequence: 0, start: new Date(), end: new Date(Date.now() + 1800000), summary });
    expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${summary}`);
    expect(ics.split("\r\n").every(line => Buffer.byteLength(line) <= 75)).toBe(true);
  });

  it("does not grant production owner privileges to the old hard-coded developer email", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRIMARY_OWNER_EMAIL", "configured@example.test");
    try {
      expect(isPrimaryOwner({ email: "mohd.aziz.sk@gmail.com" })).toBe(false);
      expect(isPrimaryOwner({ email: "configured@example.test" })).toBe(true);
    } finally { vi.stubEnv("NODE_ENV", "test"); }
  });

  it("reuses the screening row, blocks placement for a pending or approved negative disposition", async () => {
    const { company, job, candidate } = await fixture();
    const screening = await caller.recruitment.candidateWorkflows.screenings.create({ candidateId: candidate.id, jobId: job.id, answers: {}, evidence: [] });
    const decision = await caller.recruitment.consequential.requestCandidateDecision({ candidateId: candidate.id, jobId: job.id, disposition: "not_proceeding", evidence: ["Missing required evidence"], rationale: "Required evidence has not been demonstrated" });
    expect(decision.screeningId).toBe(screening.id);
    const request = { candidateId: candidate.id, companyId: company.id, jobId: job.id };
    await expect(caller.recruitment.placements.create(request)).rejects.toThrow(/positive final candidate decision/i);
    await caller.recruitment.approvals.decide({ id: decision.approvalId, decision: "approved" });
    await expect(caller.recruitment.placements.create(request)).rejects.toThrow(/positive final candidate decision/i);
  });

  it("does not share through a generic state transition or a stale post-withdrawal approval", async () => {
    const { company, job, candidate } = await fixture();
    const share = await caller.recruitment.matching.requestShareApproval({ candidateId: candidate.id, jobId: job.id, companyId: company.id });
    await expect(caller.recruitment.candidateWorkflows.shortlists.updateState({ id: share.shortlistId, status: "shared" })).rejects.toThrow(/governed approval/i);
    await caller.recruitment.candidates.withdraw({ candidateId: candidate.id });
    await expect(caller.recruitment.approvals.decide({ id: share.approvalId, decision: "approved" })).rejects.toThrow(/stale|eligible|consent/i);
    expect((await db.select().from(shortlists).where(eq(shortlists.id, share.shortlistId)))[0].status).toBe("withdrawn");
    expect((await db.select().from(approvals).where(eq(approvals.id, share.approvalId)))[0].status).toBe("pending");
  });

  it("records partial receipts, deduplicates retries and settles only the remaining balance", async () => {
    const { company, job, candidate } = await fixture();
    const decision = await caller.recruitment.consequential.requestCandidateDecision({ candidateId: candidate.id, jobId: job.id, disposition: "advance", evidence: ["Relevant experience demonstrated"], rationale: "All job requirements have been demonstrated" });
    await caller.recruitment.approvals.decide({ id: decision.approvalId, decision: "approved" });
    const placement = await caller.recruitment.placements.create({ companyId: company.id, jobId: job.id, candidateId: candidate.id });
    const invoiceId = createId("inv_");
    await db.insert(invoices).values({ id: invoiceId, ownerId, companyId: company.id, placementId: placement.id, invoiceNumber: invoiceId, amount: 100000, taxAmount: 0, currency: "INR", status: "payment_pending" });
    const receipt = { id: invoiceId, amount: 1, provider: "test_bank", providerEventId: createId("receipt_") };
    expect(await caller.recruitment.invoices.recordPayment(receipt)).toMatchObject({ status: "partially_paid", remainingBalance: 99999 });
    expect(await caller.recruitment.invoices.recordPayment(receipt)).toMatchObject({ alreadyRecorded: true });
    await expect(caller.recruitment.invoices.recordPayment({ ...receipt, amount: 2 })).rejects.toThrow(/different receipt/i);
    await expect(caller.recruitment.invoices.recordPayment({ ...receipt, providerEventId: createId("receipt_"), amount: 100000 })).rejects.toThrow(/remaining invoice balance/i);
    expect(await caller.recruitment.invoices.recordPayment({ ...receipt, providerEventId: createId("receipt_"), amount: 99999 })).toMatchObject({ status: "paid", remainingBalance: 0 });
    expect((await db.select().from(payments).where(eq(payments.invoiceId, invoiceId))).filter((p: any) => p.status === "succeeded")).toHaveLength(2);
  });

  it("quarantines uploads until scan completion, then extracts and parses without persistent raw CV payloads", async () => {
    const { candidate } = await fixture();
    infer.mockClear();
    const uploaded = await caller.recruitment.candidates.documents.upload({ candidateId: candidate.id, originalName: "cv.txt", mimeType: "text/plain", documentType: "cv", dataBase64: Buffer.from("TypeScript engineer with six years of API development.").toString("base64") });
    const initial = (await db.select().from(automationQueue).where(eq(automationQueue.ownerId, ownerId))).filter((j: any) => j.payload.documentId === uploaded.id);
    expect(initial.map((j: any) => j.jobType)).toEqual(["scan_document"]);
    expect(infer).not.toHaveBeenCalled();
    expect(await processOneQueuedJob(ownerId)).toMatchObject({ status: "completed" });
    expect(infer).not.toHaveBeenCalled();
    const parse = (await db.select().from(automationQueue).where(eq(automationQueue.ownerId, ownerId))).find((j: any) => j.jobType === "parse_cv" && j.payload.documentId === uploaded.id);
    expect(parse.payload).not.toHaveProperty("cvText");
    expect(await processOneQueuedJob(ownerId)).toMatchObject({ status: "completed" });
    expect(infer).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ cvText: expect.stringContaining("TypeScript engineer") }) }));
    expect((await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, uploaded.id)))[0]).toMatchObject({ scanState: "clean", parseState: "parsed" });
    const second = await caller.recruitment.candidates.documents.upload({ candidateId: candidate.id, originalName: "cv.txt", mimeType: "text/plain", documentType: "other", dataBase64: Buffer.from("A different immutable document.").toString("base64") });
    expect(second.storageUrl).not.toBe(uploaded.storageUrl);
  });

  it("passes requirements and clean parsed CV evidence into queued scoring", async () => {
    const { job, candidate } = await fixture();
    const documentId = createId("doc_");
    await db.insert(candidateDocuments).values({ id: documentId, ownerId, candidateId: candidate.id, storageKey: "test/reference", storageUrl: "private://test", originalName: "cv.txt", mimeType: "text/plain", sizeBytes: 20, scanState: "clean", parseState: "parsed", parsedData: { skills: ["TypeScript"], totalExperienceYears: 6 } });
    const queued = await caller.recruitment.matching.queueScoreMatch({ candidateId: candidate.id, jobId: job.id });
    const payload = (await db.select().from(automationQueue).where(eq(automationQueue.id, queued.queueId)))[0].payload;
    expect(payload.job).toMatchObject({ mustHaveSkills: ["TypeScript"], experienceMinYears: 5, compensationMin: 100000, description: "Build reliable APIs" });
    expect(payload.candidate.evidence[0]).toMatchObject({ documentId, parsedData: { skills: ["TypeScript"] } });
    expect(payload.candidate).not.toHaveProperty("fullName");
  });

  it("authorizes email without sending; one approval can be consumed only once", async () => {
    const { company } = await fixture();
    const conversationId = createId("cnv_");
    const identityId = createId("eid_");
    await db.insert(conversations).values({ id: conversationId, ownerId, companyId: company.id, channel: "email" });
    await db.insert(emailIdentities).values({ id: identityId, ownerId, email: `${identityId}@overseasjob.in`, purpose: "clients", displayName: "Test", status: "active" });
    const mail = await caller.email.outbound.requestApproval({ conversationId, senderIdentityId: identityId, recipient: "client@example.test", subject: "Test only", body: "A synthetic sandbox message." });
    send.mockClear();
    await caller.recruitment.approvals.decide({ id: mail.approvalId, decision: "approved" });
    expect(send).not.toHaveBeenCalled();
    await db.update(messages).set({ body: "Unauthorized changed content" }).where(eq(messages.id, mail.messageId));
    await expect(caller.email.outbound.deliverApproved({ messageId: mail.messageId })).rejects.toThrow(/content changed/);
    expect(send).not.toHaveBeenCalled();
    await db.update(messages).set({ body: "A synthetic sandbox message." }).where(eq(messages.id, mail.messageId));
    const results = await Promise.allSettled([caller.email.outbound.deliverApproved({ messageId: mail.messageId }), caller.email.outbound.deliverApproved({ messageId: mail.messageId })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records one failed AI attempt when domain result application fails, instead of stranding a running task", async () => {
    await db.update(automationQueue).set({ status: "cancelled" }).where(and(eq(automationQueue.ownerId, ownerId), eq(automationQueue.status, "queued")));
    const { candidate } = await fixture();
    const uploaded = await caller.recruitment.candidates.documents.upload({ candidateId: candidate.id, originalName: "late-cv.txt", mimeType: "text/plain", documentType: "cv", dataBase64: Buffer.from("TypeScript engineer with six years of API development.").toString("base64") });
    await processOneQueuedJob(ownerId);
    const task = (await db.select().from(automationQueue).where(eq(automationQueue.ownerId, ownerId))).find((j: any) => j.jobType === "parse_cv" && j.payload.documentId === uploaded.id);
    const id = task.id;
    infer.mockImplementationOnce(async () => {
      await db.update(candidates).set({ profileState: "withdrawn", withdrawnAt: new Date() }).where(eq(candidates.id, candidate.id));
      return { result: { headline: "Late AI result", skills: [], totalExperienceYears: 6, recentRoles: [], education: [], missingInformation: [], confidence: 90 }, selectedModel: "test-model", latencyMs: 1 };
    });
    expect(await processOneQueuedJob(ownerId)).toMatchObject({ jobId: id, status: "permanently_failed" });
    expect((await db.select().from(automationQueue).where(eq(automationQueue.id, id)))[0]).toMatchObject({ status: "permanently_failed", lockToken: null });
    const usage = await db.select().from(aiUsage).where(eq(aiUsage.queueJobId, id));
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe("permanently_failed");
  });

  it("quarantines an expired worker attempt instead of executing the external effect again", async () => {
    const id = createId("que_");
    await db.insert(automationQueue).values({ id, ownerId, jobType: "send_reminder", payload: {}, status: "running", lockToken: "expired-worker", lockedAt: new Date(Date.now() - 31 * 60_000), attempts: 1, maxAttempts: 3, scheduledAt: new Date(), idempotencyKey: id });
    await processOneQueuedJob(ownerId);
    expect((await db.select().from(automationQueue).where(eq(automationQueue.id, id)))[0]).toMatchObject({ status: "blocked", lockToken: null, lastError: expect.stringContaining("lease expired") });
  });

  it.skipIf(!process.env.FREEHR_TEST_MYSQL)("serializes concurrent partial receipts against the actual MySQL invoice lock", async () => {
    const { company, job, candidate } = await fixture();
    const selection = await caller.recruitment.consequential.requestCandidateDecision({ candidateId: candidate.id, jobId: job.id, disposition: "advance", evidence: ["Verified synthetic selection evidence"], rationale: "Synthetic owner selection for the database concurrency fixture" });
    await caller.recruitment.approvals.decide({ id: selection.approvalId, decision: "approved" });
    const placement = await caller.recruitment.placements.create({ companyId: company.id, candidateId: candidate.id, jobId: job.id });
    const invoiceId = createId("inv_");
    await db.insert(invoices).values({ id: invoiceId, ownerId, companyId: company.id, placementId: placement.id, invoiceNumber: invoiceId, amount: 100000, taxAmount: 0, currency: "INR", status: "payment_pending" });
    const results = await Promise.allSettled([1, 2].map(() => caller.recruitment.invoices.recordPayment({ id: invoiceId, provider: "test_bank", providerEventId: createId("receipt_"), amount: 60000 })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const receipts = await db.select().from(payments).where(eq(payments.invoiceId, invoiceId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].amount).toBe(60000);
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("partially_paid");
  });
});
