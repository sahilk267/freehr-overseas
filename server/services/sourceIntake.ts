import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { intakeBatches, intakeSources, workflowEvents, workspaceSettings } from "../../drizzle/schema";
import { candidateIntakeRecord, intakeBatchInput, prospectIntakeRecord, type IntakeOutcome } from "../../shared/intake";
import { createId, ensureWorkspace, requireDb } from "../db";
import { findCandidateIdentity, findContactIdentity, findProspectIdentity, intakeCandidateInTransaction, intakeContactInTransaction, intakeProspectInTransaction } from "./canonicalIntake";
import { lockedSelect, withWorkspaceTransaction } from "./database";
import { appendWorkflowEvent, workflowHash } from "./workflowStore";

type Source = typeof intakeSources.$inferSelect;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const endpoint = (id: string) => `/api/integrations/intake/${id}`;
const safeSource = ({ tokenHash: _secret, ...source }: Source) => ({ ...source, endpoint: endpoint(source.id) });
const unauthorized = () => new TRPCError({ code: "UNAUTHORIZED", message: "Source authentication failed." });

export async function requireIntakeSource(tx: any, ownerId: number, sourceId: string): Promise<Source> {
  const source = (await lockedSelect(tx.select().from(intakeSources).where(and(eq(intakeSources.ownerId, ownerId), eq(intakeSources.id, sourceId))).limit(1)))[0];
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Intake source was not found." });
  return { ...source };
}

export async function listIntakeSources(ownerId: number) {
  return ((await requireDb()).select().from(intakeSources).where(eq(intakeSources.ownerId, ownerId)).orderBy(desc(intakeSources.createdAt)).limit(100)).then((rows: Source[]) => rows.map(safeSource));
}

export async function createIntakeSource(ownerId: number, actorId: number, input: { name: string; kind: "candidate" | "prospect"; requestKey: string }) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const existing = (await tx.select().from(intakeSources).where(and(eq(intakeSources.ownerId, ownerId), eq(intakeSources.requestKey, input.requestKey))).limit(1))[0];
    if (existing) {
      if (existing.name !== input.name || existing.kind !== input.kind) throw new TRPCError({ code: "CONFLICT", message: "Request key belongs to a different source." });
      return { source: safeSource(existing), token: null, alreadyCreated: true };
    }
    const id = createId("src_"), token = randomBytes(32).toString("base64url");
    await tx.insert(intakeSources).values({ id, ownerId, name: input.name, kind: input.kind, requestKey: input.requestKey, tokenHash: tokenDigest(token), revision: 1, enabled: true, createdById: actorId, lastReceivedAt: null });
    await appendWorkflowEvent(tx, ownerId, "intake.source_created", id, 1, { actorId, kind: input.kind });
    return { source: safeSource(await requireIntakeSource(tx, ownerId, id)), token, alreadyCreated: false };
  });
}

export async function controlIntakeSource(ownerId: number, actorId: number, input: { id: string; expectedRevision: number; action: "enable" | "disable" | "rotate_key" }) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const source = await requireIntakeSource(tx, ownerId, input.id);
    if (source.revision !== input.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Source changed. Reload before changing access." });
    const token = input.action === "rotate_key" ? randomBytes(32).toString("base64url") : null;
    await tx.update(intakeSources).set({ revision: source.revision + 1, ...(token ? { tokenHash: tokenDigest(token) } : { enabled: input.action === "enable" }) }).where(eq(intakeSources.id, source.id));
    await appendWorkflowEvent(tx, ownerId, `intake.source_${input.action}`, source.id, source.revision + 1, { actorId });
    return { source: safeSource(await requireIntakeSource(tx, ownerId, source.id)), token };
  });
}

function parseBatch(source: Source, body: unknown) {
  let batch;
  try {
    batch = intakeBatchInput.parse(body);
    if (batch.kind !== source.kind) throw new TRPCError({ code: "BAD_REQUEST", message: "Source key is scoped to a different intake kind." });
    const records = batch.records.map(row => source.kind === "candidate" ? candidateIntakeRecord.parse(row) : prospectIntakeRecord.parse(row));
    if (new Set(records.map(row => row.externalKey)).size !== records.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Each batch needs unique external record keys." });
    return { ...batch, records };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const issue = error instanceof z.ZodError ? error.issues[0]?.message : "Invalid input";
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid intake batch: ${issue}` });
  }
}

type ParsedBatch = ReturnType<typeof parseBatch>;
async function priorRecord(tx: any, source: Source, record: ParsedBatch["records"][number]) {
  const keyHash = workflowHash(record.externalKey);
  const eventKey = workflowHash(["intake.record_received", source.id, 1, keyHash]);
  const event = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, source.ownerId), eq(workflowEvents.eventKey, eventKey))).limit(1))[0];
  return { keyHash, previous: event?.metadata as { payloadHash: string; outcome: IntakeOutcome } | undefined, payloadHash: workflowHash(record) };
}

async function assessRecord(tx: any, source: Source, row: ParsedBatch["records"][number]): Promise<IntakeOutcome> {
  const prior = await priorRecord(tx, source, row);
  if (prior.previous) {
    if (prior.previous.payloadHash !== prior.payloadHash) return { externalKeyHash: prior.keyHash, status: "conflict", reason: "This external record key has different prior content. Review a correction; no existing profile was overwritten." };
    return { ...prior.previous.outcome, status: "reused" };
  }
  try {
    if (source.kind === "candidate") {
      const record = row as z.infer<typeof candidateIntakeRecord>;
      const identity = await findCandidateIdentity(tx, source.ownerId, record);
      return { externalKeyHash: prior.keyHash, status: identity.existing ? "reused" : "created", ...(identity.existing ? { resourceId: identity.existing.id } : {}) };
    }
    const record = row as z.infer<typeof prospectIntakeRecord>;
    const identity = await findProspectIdentity(tx, source.ownerId, record);
    if (record.contact) await findContactIdentity(tx, source.ownerId, { ...record.contact, companyId: identity.existing?.id ?? "new_company" });
    return { externalKeyHash: prior.keyHash, status: identity.existing ? "reused" : "created", ...(identity.existing ? { resourceId: identity.existing.id } : {}) };
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return { externalKeyHash: prior.keyHash, status: error.code === "CONFLICT" ? "conflict" : "blocked", reason: error.message };
  }
}

async function previewBatch(tx: any, source: Source, batch: ParsedBatch) {
  const results: IntakeOutcome[] = [];
  for (const row of batch.records) results.push(await assessRecord(tx, source, row));
  return { results, previewHash: workflowHash([source.id, source.revision, batch, results]) };
}

export async function previewIntake(ownerId: number, sourceId: string, body: unknown) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const source = await requireIntakeSource(tx, ownerId, sourceId);
    return previewBatch(tx, source, parseBatch(source, body));
  });
}

async function commitIntake(tx: any, source: Source, batch: ParsedBatch, expectedPreview?: string) {
  if (!source.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source is disabled." });
  const payloadHash = workflowHash(batch);
  const existing = (await tx.select().from(intakeBatches).where(and(eq(intakeBatches.ownerId, source.ownerId), eq(intakeBatches.sourceId, source.id), eq(intakeBatches.batchKey, batch.batchKey))).limit(1))[0];
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new TRPCError({ code: "CONFLICT", message: "Batch key already belongs to different content." });
    return { id: existing.id as string, alreadyProcessed: true, results: existing.results as IntakeOutcome[] };
  }
  if (expectedPreview && (await previewBatch(tx, source, batch)).previewHash !== expectedPreview) throw new TRPCError({ code: "CONFLICT", message: "Identity evidence changed since preview. Review the batch again." });
  const recent = await tx.select({ id: intakeBatches.id }).from(intakeBatches).where(and(eq(intakeBatches.sourceId, source.id), eq(intakeBatches.ownerId, source.ownerId), gte(intakeBatches.createdAt, new Date(Date.now() - 60_000)))).limit(10);
  if (recent.length >= 10) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "This source accepts at most ten new batches per minute. Retry later with the same batch key." });
  const results: IntakeOutcome[] = [];
  for (const row of batch.records) {
    const assessment = await assessRecord(tx, source, row);
    if (["blocked", "conflict"].includes(assessment.status)) { results.push(assessment); continue; }
    const prior = await priorRecord(tx, source, row);
    if (prior.previous) { results.push(assessment); continue; }
    let result: { id: string; alreadyExists: boolean }, contactId: string | undefined;
    if (source.kind === "candidate") result = await intakeCandidateInTransaction(tx, source.ownerId, { ...row as z.infer<typeof candidateIntakeRecord>, sourceType: "approved_source" });
    else {
      const record = row as z.infer<typeof prospectIntakeRecord>;
      result = await intakeProspectInTransaction(tx, source.ownerId, { ...record, sourceType: "approved_source", confidence: 0 });
      if (record.contact) contactId = (await intakeContactInTransaction(tx, source.ownerId, { ...record.contact, companyId: result.id, sourceUrl: record.sourceUrl })).id;
    }
    const outcome: IntakeOutcome = { externalKeyHash: prior.keyHash, status: result.alreadyExists ? "reused" : "created", resourceId: result.id, ...(contactId ? { contactId } : {}) };
    await appendWorkflowEvent(tx, source.ownerId, "intake.record_received", source.id, 1, { payloadHash: prior.payloadHash, outcome }, prior.keyHash);
    results.push(outcome);
  }
  const id = createId("ibt_");
  await tx.insert(intakeBatches).values({ id, ownerId: source.ownerId, sourceId: source.id, batchKey: batch.batchKey, payloadHash, results });
  await tx.update(intakeSources).set({ lastReceivedAt: new Date() }).where(eq(intakeSources.id, source.id));
  await appendWorkflowEvent(tx, source.ownerId, "intake.batch_processed", id, 1, { sourceId: source.id, created: results.filter(r => r.status === "created").length, reused: results.filter(r => r.status === "reused").length, held: results.filter(r => ["conflict", "blocked"].includes(r.status)).length });
  return { id, alreadyProcessed: false, results };
}

export async function importReviewedIntake(ownerId: number, sourceId: string, body: unknown, previewHash: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const source = await requireIntakeSource(tx, ownerId, sourceId);
    return commitIntake(tx, source, parseBatch(source, body), previewHash);
  });
}

function authenticateSource(source: Source | undefined, token: string) {
  if (!source?.enabled || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(source.tokenHash)) throw unauthorized();
  if (!timingSafeEqual(Buffer.from(source.tokenHash, "hex"), Buffer.from(tokenDigest(token), "hex"))) throw unauthorized();
}

/** Shared machine-source authentication, including a locked rotation/disable recheck. */
export async function withAuthenticatedIntakeSource<T>(input: { sourceId: string; authorization?: string }, command: (tx: any, source: Source) => Promise<T>): Promise<T> {
  const token = input.authorization?.startsWith("Bearer ") ? input.authorization.slice(7) : "";
  if (!token || token.length !== 43) throw unauthorized();
  const db = await requireDb();
  const source: Source | undefined = (await db.select().from(intakeSources).where(eq(intakeSources.id, input.sourceId)).limit(1))[0];
  authenticateSource(source, token);
  await ensureWorkspace(source!.ownerId);
  return db.transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, source!.ownerId)).limit(1));
    const current = await requireIntakeSource(tx, source!.ownerId, source!.id);
    authenticateSource(current, token);
    return command(tx, current);
  });
}

export async function processIntakeWebhook(input: { sourceId: string; authorization?: string; body: unknown }) {
  try {
    const result = await withAuthenticatedIntakeSource(input, (tx, source) => commitIntake(tx, source, parseBatch(source, input.body)));
    return { statusCode: 200, body: result };
  } catch (error) {
    if (error instanceof TRPCError) return { statusCode: getHTTPStatusCodeFromError(error), body: { error: error.message, code: error.code } };
    console.error("Source intake failed", { sourceId: input.sourceId });
    return { statusCode: 500, body: { error: "Intake could not be committed. Retry with the same batch key." } };
  }
}
