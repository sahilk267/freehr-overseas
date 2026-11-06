import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { automationQueue, workflowEvents } from '../../drizzle/schema';
import { followupFixture } from '../testSupport/followupFixture';
import { docxFixture, pdfFixture, syntheticJdText, zipFixture } from '../testSupport/documentFixture';
import { jobDocumentMimeTypes, MAX_JOB_DOCUMENT_BYTES } from '../../shared/jobDocument';
import { importJobDocument, listJobDocuments } from './jobDocument';
import { requestJobExtraction, jobExtractionAiInput, recordJobExtractionResult, applyJobExtraction } from './jobExtraction';
import { withWorkspaceTransaction } from './database';
import { checkDocxContainer, extractDocumentText } from './documentText';
import * as dbModule from '../db';
import { PDFParse } from 'pdf-parse';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = await followupFixture(), jobId = (await f.caller.recruitment.jobs.create({ companyId: f.companyId, title: 'Synthetic document role', department: 'Preserved owner department' })).id;
  const intake = () => f.caller.recruitment.jobs.intake({ id: jobId }), d = await intake();
  const input = { jobId, expectedRevision: d.revision, expectedFingerprint: d.editFingerprint, fileName: 'client-jd.txt', mimeType: 'text/plain' as const, contentBase64: Buffer.from(syntheticJdText).toString('base64') };
  const upload = (patch = {}) => importJobDocument(f.ownerId, f.ownerId, { ...input, ...patch });
  return { ...f, jobId, d, input, intake, upload };
}
describe('requirement document import into existing versioned extraction', () => {
  it('imports actual text-based PDF and DOCX through shared parsers without saving raw files or changing jobs', async () => {
    const f = await fixture();
    for (const [bytes, mimeType, fileName] of [[pdfFixture(), jobDocumentMimeTypes[0], 'jd.pdf'], [docxFixture(), jobDocumentMimeTypes[1], 'jd.docx']] as const) {
      const doc = await f.upload({ contentBase64: bytes.toString('base64'), mimeType, fileName });
      expect(doc.sourceText).toContain('Backend Engineer'); expect(doc.stale).toBe(false);
      const row = (await f.db.select().from(workflowEvents).where(eq(workflowEvents.eventKey, doc.documentImportId)))[0];
      expect(row.metadata).toMatchObject({ rawFileRetained: false, comprehensiveMalwareScan: false, sizeBytes: bytes.length });
      expect(row.metadata).not.toHaveProperty('contentBase64'); expect(row.metadata).not.toHaveProperty('storageKey');
    }
    expect((await f.intake()).revision).toBe(1);
    expect(await f.db.select().from(automationQueue).where(eq(automationQueue.ownerId, f.ownerId))).toHaveLength(0);
  });
  it('coalesces identical file retries against one requirement snapshot and sanitizes file names', async () => {
    const f = await fixture(), a = await f.upload({ fileName: '../../client-jd.txt' }), b = await f.upload({ fileName: 'renamed.txt' });
    expect(a.fileName).toBe('client-jd.txt'); expect(b.documentImportId).toBe(a.documentImportId); expect(b.alreadyExists).toBe(true);
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(1);
  });
  it('binds a reviewed contiguous document excerpt to one task and retains its origin on adoption', async () => {
    const f = await fixture(), doc = await f.upload();
    const input = { jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, sourceText: syntheticJdText.slice(0, syntheticJdText.indexOf(' Annual salary')), sourceLabel: 'Reviewed JD excerpt', documentImportId: doc.documentImportId };
    const queued = await requestJobExtraction(f.ownerId, f.ownerId, input);
    expect((await requestJobExtraction(f.ownerId, f.ownerId, input)).queueId).toBe(queued.queueId);
    const task = (await f.db.select().from(automationQueue).where(eq(automationQueue.id, queued.queueId)))[0];
    await withWorkspaceTransaction(f.ownerId, async tx => {
      expect((await jobExtractionAiInput(tx, f.ownerId, task.payload)).sourceText).toBe(input.sourceText);
      await recordJobExtractionResult(tx, f.ownerId, task.payload, { facts: [{ field: 'title', value: 'Backend Engineer', quote: 'Role title: Backend Engineer.' }], unresolved: [], confidence: 90 }, 'synthetic/model:free');
    });
    await applyJobExtraction(f.ownerId, f.ownerId, { extractionId: queued.extractionId, selectedIndexes: [0], useSourceAsDescription: false, replaceExisting: true, reason: 'Reviewed the literal document source and selected title' });
    const applied = (await f.db.select().from(workflowEvents).where(and(eq(workflowEvents.eventType, 'job.extraction_applied'), eq(workflowEvents.aggregateId, queued.extractionId))))[0];
    expect(applied.metadata).toMatchObject({ documentImportId: doc.documentImportId, documentSha256: doc.sha256 });
    expect((await f.intake()).fields.department).toBe('Preserved owner department');
    expect((await f.intake()).assessment.confirmationVerified).toBe(false);
  });
  it('rejects fabricated excerpts and documents belonging to another job or workspace', async () => {
    const f = await fixture(), doc = await f.upload(), other = await fixture();
    const input = { jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, sourceText: syntheticJdText, sourceLabel: 'Document source', documentImportId: doc.documentImportId };
    await expect(requestJobExtraction(f.ownerId, f.ownerId, { ...input, sourceText: syntheticJdText + ' Fabricated authority.' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(requestJobExtraction(other.ownerId, other.ownerId, { ...input, jobId: other.jobId, expectedFingerprint: other.d.editFingerprint })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(listJobDocuments(other.ownerId, f.jobId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sameOwnerJob = (await f.caller.recruitment.jobs.create({ companyId: f.companyId, title: 'Other owner job' })).id, d = await f.caller.recruitment.jobs.intake({ id: sameOwnerJob });
    await expect(requestJobExtraction(f.ownerId, f.ownerId, { ...input, jobId: sameOwnerJob, expectedFingerprint: d.editFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(importJobDocument(other.ownerId, other.ownerId, f.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('makes old imports stale after an intake edit and permits a fresh import of identical bytes', async () => {
    const f = await fixture(), doc = await f.upload();
    await f.caller.recruitment.jobs.updateIntake({ jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, fields: { ...f.d.fields, headcount: 3 }, reason: 'Changed hiring quantity after document review' });
    expect((await listJobDocuments(f.ownerId, f.jobId))[0].stale).toBe(true);
    const d = await f.intake();
    await expect(f.upload()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(requestJobExtraction(f.ownerId, f.ownerId, { jobId: f.jobId, expectedRevision: d.revision, expectedFingerprint: d.editFingerprint, sourceText: syntheticJdText, sourceLabel: 'Stale document', documentImportId: doc.documentImportId })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await f.upload({ expectedRevision: d.revision, expectedFingerprint: d.editFingerprint })).documentImportId).not.toBe(doc.documentImportId);
  });
  it('rejects malformed and oversized base64, mismatched formats, executables and flagged content', async () => {
    const f = await fixture();
    for (const patch of [
      { contentBase64: '!!!!' }, { contentBase64: Buffer.alloc(MAX_JOB_DOCUMENT_BYTES + 1, 65).toString('base64') },
      { fileName: 'jd.pdf' }, { mimeType: 'application/pdf', fileName: 'jd.pdf' },
      { contentBase64: Buffer.from('#!/bin/sh\n'+syntheticJdText).toString('base64') },
      { contentBase64: Buffer.from(syntheticJdText+' <script>bad</script>').toString('base64') },
    ]) await expect(f.upload(patch)).rejects.toThrow();
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(0);
  });
  it('does not silently truncate long imported text and requires an explicit bounded extraction excerpt', async () => {
    const f = await fixture(), long = syntheticJdText + ' Complete requirement evidence.'.repeat(400), doc = await f.upload({ contentBase64: Buffer.from(long).toString('base64') });
    expect(doc.sourceText).toBe(long); expect(doc.sourceText.length).toBeGreaterThan(8500);
    await expect(requestJobExtraction(f.ownerId, f.ownerId, { jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, sourceText: doc.sourceText, sourceLabel: 'Long import', documentImportId: doc.documentImportId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(f.upload({ contentBase64: Buffer.from('A'.repeat(50001)).toString('base64') })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('rejects invalid UTF-8, empty scans, corrupt PDF and malformed DOCX without persisting an import', async () => {
    const f = await fixture();
    for (const patch of [
      { contentBase64: Buffer.concat([Buffer.from(syntheticJdText), Buffer.from([0xff])]).toString('base64') },
      { fileName: 'blank.pdf', mimeType: jobDocumentMimeTypes[0], contentBase64: pdfFixture('').toString('base64') },
      { fileName: 'broken.pdf', mimeType: jobDocumentMimeTypes[0], contentBase64: Buffer.from('%PDF-1.4 broken').toString('base64') },
      { fileName: 'broken.docx', mimeType: jobDocumentMimeTypes[1], contentBase64: zipFixture({ 'not-a-doc.txt': syntheticJdText }).toString('base64') },
    ]) await expect(f.upload(patch)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(0);
  });
  it('bounds ZIP expansion and rejects macro, encrypted and traversal entries before DOCX parsing', () => {
    for (const entries of [{ '../bad.xml': 'x' }, { 'word/vbaProject.bin': 'x' }, { 'word/document.xml': 'X'.repeat(5*1024*1024+1) }]) expect(() => checkDocxContainer(zipFixture(entries))).toThrow();
    const encrypted = docxFixture(), central = encrypted.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); encrypted.writeUInt16LE(1, central+8);
    expect(() => checkDocxContainer(encrypted)).toThrow(/Encrypted/);
    const bomb = docxFixture('A'.repeat(20000)), entry = bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]), bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]))+4); bomb.writeUInt32LE(4, entry+24);
    expect(() => checkDocxContainer(bomb)).toThrow();
  });
  it('retains prior CV truncation behavior while strict imports fail on overflow', async () => {
    expect((await extractDocumentText(Buffer.from('X'.repeat(13000)), 'text/plain')).length).toBe(12000);
    await expect(extractDocumentText(Buffer.from('X'.repeat(13000)), 'text/plain', { rejectOverflow: true })).rejects.toThrow(/character limit/);
  });
  it('rejects an oversized page count before extracting any PDF text', async () => {
    vi.spyOn(PDFParse.prototype, 'getInfo').mockResolvedValue({ total: 101 } as never);
    const getText = vi.spyOn(PDFParse.prototype, 'getText');
    await expect(extractDocumentText(pdfFixture(), jobDocumentMimeTypes[0], { maxPdfPages: 100, rejectOverflow: true })).rejects.toThrow(/page limit/);
    expect(getText).not.toHaveBeenCalled();
  });
  it('prevents imports outside a draft even when the requirement fingerprint is current', async () => {
    const f = await fixture(); await f.caller.recruitment.jobs.transition({ id: f.jobId, state: 'client_confirmation' });
    const d = await f.intake();
    await expect(f.upload({ expectedFingerprint: d.editFingerprint })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(0);
  });
  it('rechecks the intake snapshot after parsing to prevent an intervening edit from binding a stale document', async () => {
    const f = await fixture();
    const parser = await import('./documentText'), original = parser.extractDocumentText;
    vi.spyOn(parser, 'extractDocumentText').mockImplementationOnce(async (...args) => {
      await f.caller.recruitment.jobs.updateIntake({ jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, fields: { ...f.d.fields, headcount: 5 }, reason: 'An independent edit while document parser runs' });
      return original(...args);
    });
    await expect(f.upload()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(0);
  });
  it('detects altered stored source provenance before inference and adoption', async () => {
    const f = await fixture(), doc = await f.upload();
    const task = await requestJobExtraction(f.ownerId, f.ownerId, { jobId: f.jobId, expectedRevision: 1, expectedFingerprint: f.d.editFingerprint, sourceText: syntheticJdText, sourceLabel: 'Imported document', documentImportId: doc.documentImportId });
    const queued = (await f.db.select().from(automationQueue).where(eq(automationQueue.id, task.queueId)))[0];
    await withWorkspaceTransaction(f.ownerId, tx => recordJobExtractionResult(tx, f.ownerId, queued.payload, { facts: [{ field: 'title', value: 'Backend Engineer', quote: 'Role title: Backend Engineer.' }], unresolved: [], confidence: 90 }, 'synthetic/model:free'));
    await f.db.update(workflowEvents).set({ metadata: { ...doc, sourceText: 'Altered stored source text.' } }).where(eq(workflowEvents.eventKey, doc.documentImportId));
    await expect(withWorkspaceTransaction(f.ownerId, tx => jobExtractionAiInput(tx, f.ownerId, queued.payload))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(applyJobExtraction(f.ownerId, f.ownerId, { extractionId: task.extractionId, selectedIndexes: [0], useSourceAsDescription: false, replaceExisting: true, reason: 'Attempting to apply after stored source was altered' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await f.intake()).revision).toBe(1);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === '1')('serializes duplicate document imports into one ledger event', async () => {
    const f = await fixture(), results = await Promise.all([f.upload(), f.upload()]);
    expect(results[0].documentImportId).toBe(results[1].documentImportId); expect(results.filter(r => r.alreadyExists)).toHaveLength(1);
    expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(1);
  });
  it.runIf(process.env.FREEHR_TEST_MYSQL === '1')('rolls back the imported text when its audit cannot be written', async () => {
    const f = await fixture(), original = dbModule.recordAudit;
    vi.spyOn(dbModule, 'recordAudit').mockImplementation(async (input, tx) => { if (input.action === 'job.document_imported') throw Error('Synthetic import audit failure'); return original(input, tx); });
    await expect(f.upload()).rejects.toThrow(/audit failure/); expect(await listJobDocuments(f.ownerId, f.jobId)).toHaveLength(0);
  });
});
