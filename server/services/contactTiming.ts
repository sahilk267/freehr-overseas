import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  contacts,
  conversations,
  followUpPlans,
  messages,
  workflowEvents,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  contactTimingSave,
  contactTimingFields,
  type ContactTimingFields,
} from "../../shared/contactTiming";
import { hashContactValue, recordAudit } from "../db";
import { withWorkspaceTransaction } from "./database";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";
import { nextContactTime } from "./workflowTiming";
const fail = (message: string) =>
  new TRPCError({ code: "PRECONDITION_FAILED", message });
const timingEvent = async (tx: any, ownerId: number, key: string) =>
  (
    await tx
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.ownerId, ownerId),
          eq(workflowEvents.eventType, "contact.timing_saved"),
          eq(workflowEvents.aggregateId, key)
        )
      )
      .orderBy(desc(workflowEvents.revision))
      .limit(1)
  )[0];
async function scope(tx: any, ownerId: number, planId: string) {
  const plan = (
      await tx
        .select()
        .from(followUpPlans)
        .where(
          and(eq(followUpPlans.ownerId, ownerId), eq(followUpPlans.id, planId))
        )
        .limit(1)
    )[0],
    thread = plan
      ? (
          await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.ownerId, ownerId),
                eq(conversations.id, plan.conversationId)
              )
            )
            .limit(1)
        )[0]
      : null;
  if (!plan || !thread || thread.channel !== "email")
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Owned email follow-up was not found.",
    });
  const person = thread.candidateId
    ? (
        await tx
          .select()
          .from(candidates)
          .where(
            and(
              eq(candidates.ownerId, ownerId),
              eq(candidates.id, thread.candidateId)
            )
          )
          .limit(1)
      )[0]
    : (
        await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.ownerId, ownerId),
              eq(contacts.id, thread.contactId ?? "")
            )
          )
          .limit(1)
      )[0];
  if (
    !person?.email ||
    person.deletedAt ||
    ["deleted", "deletion_pending"].includes(person.profileState) ||
    hashContactValue(person.email) !== plan.recipientHash
  )
    throw fail("The recorded recipient changed or is no longer available.");
  return {
    plan,
    thread,
    person,
    key: plan.recipientHash as string,
    candidateId: thread.candidateId ?? null,
    contactId: thread.contactId ?? null,
  };
}
export async function getRecipientTiming(
  tx: any,
  ownerId: number,
  recipientHash: string
) {
  const row = await timingEvent(tx, ownerId, recipientHash);
  if (!row || row.metadata.redacted || row.metadata.active === false)
    return null;
  const parsed = contactTimingFields.safeParse(row.metadata.fields);
  if (!parsed.success)
    throw fail(
      "Recipient timing evidence is invalid. Review or explicitly retire the restriction before sending."
    );
  return { fields: parsed.data, revision: row.revision };
}
/** Intersect restrictions; never widen workspace policy or create channel authority. */
export function nextRecipientContactTime(
  now: Date,
  workspace: {
    timezone: string;
    quietStart: string;
    quietEnd: string;
    businessDaysOnly?: boolean;
    nextDay?: boolean;
  },
  fields: ContactTimingFields | null
) {
  if (!fields) return nextContactTime(now, workspace);
  if (fields.validUntil <= now)
    throw fail(
      "Recipient timing evidence expired. Review or explicitly retire it before sending."
    );
  if (fields.preferredChannel !== "email")
    throw fail(
      "Recipient prefers another channel. Email is withheld; use an approved adapter and permission for that channel."
    );
  if (fields.window?.start === fields.window?.end && fields.window)
    throw fail("The recorded recipient contact window is empty.");
  let at = new Date(Math.max(now.getTime(), fields.notBefore?.getTime() ?? 0));
  for (let i = 0; i < 24; i++) {
    const workspaceAt = nextContactTime(at, workspace),
      recipientAt = fields.window
        ? nextContactTime(workspaceAt, {
            timezone: fields.timezone,
            quietStart: fields.window.end,
            quietEnd: fields.window.start,
            businessDaysOnly: fields.window.businessDaysOnly,
          })
        : workspaceAt;
    if (recipientAt >= fields.validUntil)
      throw fail(
        "No jointly permitted contact window exists within the current timing evidence."
      );
    if (recipientAt.getTime() === workspaceAt.getTime()) return recipientAt;
    at = recipientAt;
  }
  throw fail(
    "Workspace and recipient contact windows do not overlap within the bounded search."
  );
}
export async function readContactTiming(ownerId: number, planId: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await scope(tx, ownerId, planId),
      current = await timingEvent(tx, ownerId, s.key),
      inbound = await tx
        .select({
          id: messages.id,
          body: messages.body,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, s.thread.id),
            eq(messages.direction, "inbound"),
            eq(messages.status, "received")
          )
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(21);
    const workspace = (
      await tx
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.ownerId, ownerId))
        .limit(1)
    )[0];
    let nextPermittedAt: string | null = null,
      timingIssue: string | null = null;
    try {
      const timing = await getRecipientTiming(tx, ownerId, s.key);
      nextPermittedAt = nextRecipientContactTime(
        new Date(),
        {
          timezone: s.plan.timezone ?? workspace.businessTimezone,
          quietStart: workspace.quietHoursStart,
          quietEnd: workspace.quietHoursEnd,
          businessDaysOnly: s.plan.businessDaysOnly,
        },
        timing?.fields ?? null
      ).toISOString();
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
      timingIssue = error.message;
    }
    return {
      nextPermittedAt,
      timingIssue,
      planId,
      revision: current?.revision ?? 0,
      record: current?.metadata?.redacted ? null : (current?.metadata ?? null),
      status:
        !current || current.metadata.active === false
          ? "unrestricted"
          : current.metadata.redacted
            ? "erased"
            : new Date(current.metadata.fields?.validUntil) <= new Date()
              ? "expired_review_required"
              : "recorded",
      sources: inbound
        .slice(0, 20)
        .map((m: any) => ({
          id: m.id,
          body: m.body.slice(0, 2000),
          truncated: m.body.length > 2000,
          createdAt: m.createdAt,
        })),
      moreSources: inbound.length > 20,
      scope:
        "The same recipient address across this workspace; changing the address does not transfer this restriction.",
      authenticity:
        "Owner-recorded interpretation of the quoted inbound source; sender identity and date interpretation are not independently verified.",
    };
  });
}
export async function saveContactTiming(
  ownerId: number,
  actorId: number,
  raw: z.input<typeof contactTimingSave>
) {
  const input = contactTimingSave.parse(raw),
    now = new Date(),
    f = input.fields;
  if (
    f.validUntil <= now ||
    f.validUntil.getTime() > now.getTime() + 90 * 86400000 ||
    (f.notBefore && f.notBefore >= f.validUntil) ||
    (f.window && f.window.start === f.window.end)
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Use a valid recipient window, with review expiry within 90 days and any return date before expiry.",
    });
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await scope(tx, ownerId, input.planId),
      m = (
        await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.id, input.messageId),
              eq(messages.conversationId, s.thread.id),
              eq(messages.direction, "inbound"),
              eq(messages.status, "received")
            )
          )
          .limit(1)
      )[0];
    if (
      !m ||
      !m.body.includes(input.sourceQuote) ||
      !m.createdAt ||
      new Date(m.createdAt).getTime() > now.getTime() + 60000
    )
      throw fail(
        "Choose an exact quotation from a received inbound record in this recipient thread."
      );
    const previous = await timingEvent(tx, ownerId, s.key),
      requestHash = workflowHash({
        messageId: input.messageId,
        sourceQuote: input.sourceQuote,
        fields: f,
        reason: input.reason,
      });
    if (
      previous?.revision === input.expectedRevision + 1 &&
      previous.metadata.requestHash === requestHash
    )
      return { revision: previous.revision, alreadySaved: true };
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Recipient timing changed. Review the current restriction.",
      });
    const revision = input.expectedRevision + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "contact.timing_saved",
      s.key,
      revision,
      {
        candidateId: s.candidateId,
        contactId: s.contactId,
        conversationId: s.thread.id,
        messageId: m.id,
        sourceBodyHash: workflowHash(m.body),
        sourceQuote: input.sourceQuote,
        fields: f,
        active: true,
        requestHash,
        reason: input.reason,
        actorId,
        independentlyVerified: false,
        scope: "agency_nonsecurity_email",
        recordedAt: now.toISOString(),
      }
    );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "contact.timing_recorded",
        resourceType: "followup_plan",
        resourceId: s.plan.id,
        metadata: {
          revision,
          recipientHash: s.key,
          independentlyVerified: false,
        },
      },
      tx
    );
    return { revision, alreadySaved: false };
  });
}
export async function retireContactTiming(
  ownerId: number,
  actorId: number,
  input: { planId: string; expectedRevision: number; reason: string }
) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const s = await scope(tx, ownerId, input.planId),
      previous = await timingEvent(tx, ownerId, s.key);
    if (!previous || previous.revision !== input.expectedRevision)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Review the current recipient restriction before retiring it.",
      });
    if (previous.metadata.active === false)
      return { revision: previous.revision, alreadyRetired: true };
    const revision = previous.revision + 1;
    await appendWorkflowEvent(
      tx,
      ownerId,
      "contact.timing_saved",
      s.key,
      revision,
      {
        candidateId: s.candidateId,
        contactId: s.contactId,
        conversationId: s.thread.id,
        active: false,
        reason: input.reason,
        actorId,
        independentlyVerified: false,
      }
    );
    await recordAudit(
      {
        ownerId,
        actorType: "user",
        actorId: String(actorId),
        action: "contact.timing_retired",
        resourceType: "followup_plan",
        resourceId: s.plan.id,
        metadata: { revision },
      },
      tx
    );
    return { revision, alreadyRetired: false };
  });
}
export async function eraseContactTiming(
  tx: any,
  ownerId: number,
  candidateId: string
) {
  const rows = await tx
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.ownerId, ownerId),
        eq(workflowEvents.eventType, "contact.timing_saved")
      )
    );
  for (const r of rows)
    if (r.metadata?.candidateId === candidateId)
      await tx
        .update(workflowEvents)
        .set({
          metadata: { redacted: true, reason: "candidate_privacy_erasure" },
        })
        .where(eq(workflowEvents.id, r.id));
}
