import { and, eq } from "drizzle-orm";
import { appRouter } from "../routers";
import { createId, ensureWorkspace, hashContactValue, requireDb } from "../db";
import { candidates, companies, consents, contacts, conversations, emailIdentities, followUpPlans, interviews, invoices, jobs, placements, users, workspaceSettings } from "../../drizzle/schema";
import { enrollFollowUp, prepareFollowUp } from "../services/followups";

export async function followupFixture() {
  const db = await requireDb(), ownerId = 1000000 + Math.floor(Math.random() * 1000000000);
  const caller = appRouter.createCaller({ user: { id: ownerId, role: "admin", openId: `w1_${ownerId}`, email: "owner@example.test" }, req: { headers: {} }, res: {} } as never);
  await db.insert(users).values({ id: ownerId, openId: `w1_${ownerId}`, role: "admin", email: "owner@example.test" });
  await ensureWorkspace(ownerId);
  await db.update(workspaceSettings).set({ quietHoursStart: "00:00", quietHoursEnd: "00:00", businessTimezone: "UTC", dailyOutboundLimit: 100, policyConfig: { followupRecipientDailyLimit: 3, minRecipientSpacingMinutes: 1 } }).where(eq(workspaceSettings.ownerId, ownerId));
  const companyId = createId("cmp_"), jobId = createId("job_"), candidateId = createId("can_"), contactId = createId("ctc_"), conversationId = createId("cnv_"), clientConversationId = createId("cnv_"), interviewId = createId("int_"), placementId = createId("plc_"), invoiceId = createId("inv_");
  const address = `${candidateId}@example.test`;
  await db.insert(companies).values({ id: companyId, ownerId, name: "Synthetic test client" });
  await db.insert(jobs).values({ id: jobId, ownerId, companyId, title: "Backend engineer", pipelineState: "open" });
  await db.insert(candidates).values({ id: candidateId, ownerId, fullName: "Synthetic candidate", email: address, emailHash: hashContactValue(address), profileState: "consented" });
  await db.insert(consents).values({ id: createId("cns_"), ownerId, candidateId, consentType: "recruitment_communication", status: "granted", noticeVersion: "test-v1" });
  await db.insert(contacts).values({ id: contactId, ownerId, companyId, name: "Synthetic client contact", email: `${contactId}@example.test`, contactPermission: "permitted" });
  await db.insert(conversations).values({ id: conversationId, ownerId, candidateId, jobId, companyId, channel: "email", status: "active" });
  await db.insert(conversations).values({ id: clientConversationId, ownerId, contactId, companyId, channel: "email", status: "active" });
  const senders: Record<string, string> = {};
  for (const purpose of ["talent", "interviews", "finance", "clients"]) {
    const id = createId("eid_"); senders[purpose] = id;
    await db.insert(emailIdentities).values({ id, ownerId, email: `${id}@overseasjob.in`, purpose, displayName: "Synthetic test sender", status: "active" });
  }
  await db.insert(interviews).values({ id: interviewId, ownerId, candidateId, companyId, jobId, status: "confirmed", calendarStatus: "confirmed", scheduledAt: new Date(Date.now() + 4 * 3600000), timezone: "UTC", reminderSentAt: null, reminderAt: new Date(Date.now() - 60000) });
  await db.insert(placements).values({ id: placementId, ownerId, companyId, candidateId, jobId });
  await db.insert(invoices).values({ id: invoiceId, ownerId, companyId, placementId, invoiceNumber: invoiceId, amount: 10000, taxAmount: 0, currency: "INR", status: "payment_pending" });
  const input = { scenarioId: "FU09", conversationId, senderIdentityId: senders.talent, objective: "Confirm candidate interest", timezone: "UTC", deadlineAt: new Date(Date.now() + 7 * 86400000), responseWindowMinutes: 60, steps: [{ delayMinutes: 0, subject: "First follow-up", body: "Please reply to confirm interest. Reply STOP to opt out." }, { delayMinutes: 60, subject: "Second follow-up", body: "Following up on the opportunity. Reply STOP to opt out." }] };
  const enroll = (overrides: Record<string, unknown> = {}) => enrollFollowUp(ownerId, { ...input, ...overrides } as never);
  const getPlan = async (id: string) => (await db.select().from(followUpPlans).where(and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, id))).limit(1))[0];
  const prepare = async (id: string) => { const p = await getPlan(id); return prepareFollowUp(ownerId, { planId: id, revision: p.revision, stepIndex: p.stepIndex }); };
  return { db, ownerId, caller, companyId, jobId, candidateId, contactId, address, conversationId, clientConversationId, interviewId, invoiceId, senders, input, enroll, getPlan, prepare };
}
