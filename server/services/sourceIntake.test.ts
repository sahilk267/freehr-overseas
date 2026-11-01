import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { candidates, companies, contacts, intakeBatches, intakeSources, suppressionList, workflowEvents } from "../../drizzle/schema";
import { createId, hashContactValue } from "../db";
import { followupFixture } from "../testSupport/followupFixture";
import { processIntakeWebhook } from "./sourceIntake";
import { buildFastifyServer } from "../hostinger";

async function fixture(kind: "candidate" | "prospect" = "candidate") {
  const f = await followupFixture();
  await f.db.update(contacts).set({ email: `${f.contactId.toLowerCase()}@example.test` }).where(eq(contacts.id, f.contactId));
  const requestKey = createId("request_");
  const registered = await f.caller.intake.sources.create({ requestKey, kind, name: "Synthetic approved source" });
  const id = registered.source.id;
  const email = `${id.toLowerCase()}@example.test`;
  const records = kind === "candidate" ? [{ externalKey: "source-A", fullName: "Synthetic imported person", email }] : [{ externalKey: "source-A", name: "Synthetic imported company", domain: `${id.toLowerCase().replaceAll("_", "-")}.example.test`, contact: { name: "Synthetic imported contact", email } }];
  const batch = { batchKey: createId("batch_"), kind, records };
  const receive = (body: unknown = batch, token = registered.token!) => processIntakeWebhook({ sourceId: id, authorization: `Bearer ${token}`, body });
  return { ...f, id, requestKey, email, token: registered.token!, batch, receive };
}

describe("approved intake with canonical identity and source-scoped machine access", () => {
  it("creates consent-pending candidates, normalizes identities, and reuses manual creation", async () => {
    const f = await fixture(), result = await f.receive();
    expect(result.statusCode).toBe(200);
    const outcome = (result.body as any).results[0];
    expect(outcome.status).toBe("created");
    const row = (await f.db.select().from(candidates).where(eq(candidates.id, outcome.resourceId)))[0];
    expect(row).toMatchObject({ email: f.email, profileState: "consent_pending", sourceType: "approved_source" });
    expect(await f.caller.recruitment.candidates.create({ fullName: "Same existing person", email: f.email.toUpperCase() })).toMatchObject({ id: row.id, alreadyExists: true });
    expect((await f.db.select().from(candidates).where(eq(candidates.id, row.id)))[0].fullName).toBe("Synthetic imported person");
  });
  it("deduplicates batch replay and rejects changed payload under its key", async () => {
    const f = await fixture(), first = await f.receive(), second = await f.receive();
    expect(second.body).toMatchObject({ id: (first.body as any).id, alreadyProcessed: true });
    const changed = await f.receive({ ...f.batch, records: [{ ...f.batch.records[0], fullName: "Changed name" }] });
    expect(changed.statusCode).toBe(409);
    expect(await f.db.select().from(intakeBatches).where(eq(intakeBatches.sourceId, f.id))).toHaveLength(1);
  });
  it("deduplicates different batches and different approved sources against the same candidate", async () => {
    const f = await fixture(), first = await f.receive();
    const other = await f.caller.intake.sources.create({ requestKey: createId(), name: "Second synthetic source", kind: "candidate" });
    const second = await processIntakeWebhook({ sourceId: other.source.id, authorization: `Bearer ${other.token}`, body: { ...f.batch, batchKey: createId() } });
    expect((second.body as any).results[0]).toMatchObject({ status: "reused", resourceId: (first.body as any).results[0].resourceId });
    expect(await f.db.select().from(candidates).where(and(eq(candidates.ownerId, f.ownerId), eq(candidates.emailHash, hashContactValue(f.email))))).toHaveLength(1);
  });
  it("does not overwrite an existing profile when a source supplies changed fields", async () => {
    const f = await fixture(); await f.receive();
    const changed = await f.receive({ ...f.batch, batchKey: createId(), records: [{ ...f.batch.records[0], headline: "Unreviewed new claim" }] });
    expect((changed.body as any).results[0]).toMatchObject({ status: "conflict" });
    expect((await f.db.select().from(candidates).where(eq(candidates.emailHash, hashContactValue(f.email))))[0].headline).toBeNull();
  });
  it("keeps external record keys case-sensitive and still deduplicates their underlying identity", async () => {
    const f = await fixture();
    const received = await f.receive({ ...f.batch, records: [{ ...f.batch.records[0], externalKey: "Key-A" }, { ...f.batch.records[0], externalKey: "key-a" }] });
    expect(received.statusCode).toBe(200);
    expect((received.body as any).results.map((r: any) => r.status)).toEqual(["created", "reused"]);
    const events = await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.aggregateId, f.id), eq(workflowEvents.eventType, "intake.record_received")));
    expect(events).toHaveLength(2);
  });
  it("reuses normalized company domains and imports contacts without contact permission", async () => {
    const f = await fixture("prospect"), first = await f.receive();
    const out = (first.body as any).results[0];
    const company = (await f.db.select().from(companies).where(eq(companies.id, out.resourceId)))[0];
    expect(company).toMatchObject({ pipelineState: "new", verificationState: "pending", companyType: "prospect", confidence: 0 });
    expect((await f.db.select().from(contacts).where(eq(contacts.id, out.contactId)))[0].contactPermission).toBe("unknown");
    expect(await f.caller.recruitment.prospects.create({ name: "Existing company variant", domain: `https://www.${company.domain}/careers` })).toMatchObject({ id: company.id, alreadyExists: true });
  });
  it("holds a conflicting contact before creating an unrelated company", async () => {
    const f = await fixture("prospect");
    const result = await f.receive({ ...f.batch, records: [{ ...f.batch.records[0], contact: { name: "Conflicting contact", email: `${f.contactId}@example.test` } }] });
    expect((result.body as any).results[0]).toMatchObject({ status: "conflict" });
    expect(await f.db.select().from(companies).where(and(eq(companies.ownerId, f.ownerId), eq(companies.domain, (f.batch.records[0] as any).domain)))).toHaveLength(0);
  });
  it("does not reactivate a suppressed identity after erasure or import", async () => {
    const f = await fixture();
    await f.db.insert(suppressionList).values({ id: createId("sup_"), ownerId: f.ownerId, channel: "email", valueHash: hashContactValue(f.email), active: true, reason: "Synthetic erasure", source: "candidate_rights" });
    const result = await f.receive();
    expect((result.body as any).results[0]).toMatchObject({ status: "blocked" });
    expect(await f.db.select().from(candidates).where(and(eq(candidates.ownerId, f.ownerId), eq(candidates.emailHash, hashContactValue(f.email))))).toHaveLength(0);
  });
  it("rejects conflicting email/phone identities rather than silently merging candidates", async () => {
    const f = await fixture();
    const a = await f.caller.recruitment.candidates.create({ fullName: "Identity A", email: f.email, phone: "+919123456789" });
    const b = await f.caller.recruitment.candidates.create({ fullName: "Identity B", email: "different@example.test", phone: "+919123456788" });
    const result = await f.receive({ ...f.batch, records: [{ ...f.batch.records[0], phone: "+919123456788" }] });
    expect((result.body as any).results[0].status).toBe("conflict");
    expect(a.id).not.toBe(b.id);
  });
  it("normalizes international phone formatting but never invents a country for national numbers", async () => {
    const f = await fixture();
    const first = await f.caller.recruitment.candidates.create({ fullName: "Phone identity", phone: "+91 (912) 345-6789" });
    expect(await f.caller.recruitment.candidates.create({ fullName: "Same phone identity", phone: "+919123456789" })).toMatchObject({ id: first.id, alreadyExists: true });
    const result = await f.receive({ ...f.batch, records: [{ externalKey: "local-phone", fullName: "Unknown country", phone: "9123456789" }] });
    expect(result.statusCode).toBe(400);
  });
  it("rejects unauthenticated, disabled, cross-source and wrong-kind access", async () => {
    const f = await fixture(), other = await fixture();
    expect((await processIntakeWebhook({ sourceId: f.id, body: f.batch })).statusCode).toBe(401);
    expect((await f.receive(f.batch, other.token)).statusCode).toBe(401);
    expect((await f.receive({ ...f.batch, kind: "prospect" })).statusCode).toBe(400);
    await f.caller.intake.sources.control({ id: f.id, expectedRevision: 1, action: "disable" });
    expect((await f.receive()).statusCode).toBe(401);
    await expect(other.caller.intake.batches({ sourceId: f.id })).rejects.toThrow(/not found/);
  });
  it("rotates keys immediately and never lists their hash or plaintext", async () => {
    const f = await fixture();
    const rotated = await f.caller.intake.sources.control({ id: f.id, expectedRevision: 1, action: "rotate_key" });
    expect((await f.receive()).statusCode).toBe(401);
    expect((await f.receive(f.batch, rotated.token!)).statusCode).toBe(200);
    const sources = await f.caller.intake.sources.list();
    expect(sources[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(sources)).not.toContain(rotated.token);
    expect((await f.db.select().from(intakeSources).where(eq(intakeSources.id, f.id)))[0].tokenHash).not.toBe(rotated.token);
    await expect(f.caller.intake.sources.control({ id: f.id, expectedRevision: 1, action: "disable" })).rejects.toThrow(/changed/);
  });
  it("source creation replay does not create another key and never recovers an earlier plaintext key", async () => {
    const f = await fixture();
    const replay = await f.caller.intake.sources.create({ requestKey: f.requestKey, kind: "candidate", name: "Synthetic approved source" });
    expect(replay).toMatchObject({ alreadyCreated: true, token: null });
    expect(replay.source.id).toBe(f.id);
  });
  it("owner preview writes nothing and changed identity evidence invalidates confirmation", async () => {
    const f = await fixture(), preview = await f.caller.intake.preview({ sourceId: f.id, batch: f.batch });
    expect(preview.results[0].status).toBe("created");
    expect(await f.db.select().from(intakeBatches).where(eq(intakeBatches.sourceId, f.id))).toHaveLength(0);
    await f.caller.recruitment.candidates.create({ fullName: "New existing identity", email: f.email });
    await expect(f.caller.intake.importReviewed({ sourceId: f.id, batch: f.batch, previewHash: preview.previewHash })).rejects.toThrow(/changed since preview/);
  });
  it("rejects privilege-bearing fields, duplicate external keys and oversized batches", async () => {
    const f = await fixture();
    for (const body of [{ ...f.batch, records: [{ ...f.batch.records[0], profileState: "consented" }] }, { ...f.batch, records: [f.batch.records[0], f.batch.records[0]] }, { ...f.batch, records: Array(51).fill(f.batch.records[0]) }]) expect((await f.receive(body)).statusCode).toBe(400);
  });
  it("limits new batches per source while allowing an identical replay at the limit", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await f.receive({ ...f.batch, batchKey: `rate-batch-${i}` })).statusCode).toBe(200);
    expect((await f.receive({ ...f.batch, batchKey: "rate-batch-10" })).statusCode).toBe(429);
    expect((await f.receive({ ...f.batch, batchKey: "rate-batch-0" })).statusCode).toBe(200);
  });
  it("wires machine authentication and body bounds into the actual Fastify endpoint", async () => {
    const f = await fixture(), app = await buildFastifyServer({ logger: false });
    try {
      const url = `/api/integrations/intake/${f.id}`;
      expect((await app.inject({ method: "POST", url, payload: f.batch })).statusCode).toBe(401);
      const result = await app.inject({ method: "POST", url, payload: f.batch, headers: { authorization: `Bearer ${f.token}` } });
      expect(result.statusCode).toBe(200); expect(result.json().results[0].status).toBe("created");
      expect((await app.inject({ method: "POST", url, payload: { padding: "x".repeat(256 * 1024) }, headers: { authorization: `Bearer ${f.token}` } })).statusCode).toBe(413);
    } finally { await app.close(); }
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === "1")("serializes competing source batches and manual creation on real MySQL", async () => {
    const f = await fixture();
    const results = await Promise.all([f.receive(), f.receive({ ...f.batch, batchKey: createId() }), f.caller.recruitment.candidates.create({ fullName: "Concurrent owner input", email: f.email })]);
    expect((results[0] as any).statusCode).toBe(200); expect((results[1] as any).statusCode).toBe(200);
    expect(await f.db.select().from(candidates).where(and(eq(candidates.ownerId, f.ownerId), eq(candidates.emailHash, hashContactValue(f.email))))).toHaveLength(1);
  });
});
