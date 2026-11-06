import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { workflowEvents } from '../../drizzle/schema';
import { jobDocumentInputSchema, MAX_JOB_DOCUMENT_BYTES } from '../../shared/jobDocument';
import type { z } from 'zod';
import { recordAudit } from '../db';
import { withWorkspaceTransaction } from './database';
import { scanDocumentBytes } from './documentScanner';
import { extractDocumentText } from './documentText';
import { jobIntakeInTransaction } from './jobIntake';
import { appendWorkflowEvent, workflowHash } from './workflowStore';

const invalid = (message: string, code: 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED' = 'BAD_REQUEST') => new TRPCError({ code, message });
const current = (d: any, input: { expectedRevision: number; expectedFingerprint: string }) => {
  if (d.revision !== input.expectedRevision || d.editFingerprint !== input.expectedFingerprint) throw invalid('Intake changed. Reload before importing this document.', 'CONFLICT');
  if (d.pipelineState !== 'draft' || !d.integrity) throw invalid('A current draft is required for document import.', 'PRECONDITION_FAILED');
};
function describe(row: any, d: any) {
  return { documentImportId: row.eventKey as string, ...row.metadata as { fileName: string; mimeType: string; sha256: string; sizeBytes: number; sourceText: string; textHash: string; baseFingerprint: string }, baseRevision: row.revision as number, stale: d.pipelineState !== 'draft' || !d.integrity || d.revision !== row.revision || d.editFingerprint !== row.metadata.baseFingerprint };
}
export async function findJobDocument(tx: any, ownerId: number, id: string) {
  const row = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventType, 'job.document_imported'), eq(workflowEvents.eventKey, id))).limit(1))[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Owned requirement document was not found.' });
  return row;
}
export async function importJobDocument(ownerId: number, actorId: number, raw: z.infer<typeof jobDocumentInputSchema>) {
  const input = jobDocumentInputSchema.parse(raw);
  // Decode only canonical base64; Buffer.from alone silently accepts malformed input.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64)) throw invalid('Document content must be canonical base64.');
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_JOB_DOCUMENT_BYTES || bytes.toString('base64') !== input.contentBase64) throw invalid('Upload a document between 1 byte and 2 MB.');
  const extension = input.mimeType === 'application/pdf' ? '.pdf' : input.mimeType === 'text/plain' ? '.txt' : '.docx';
  const fileName = input.fileName.replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop()!.trim();
  if (!fileName.toLowerCase().endsWith(extension) || fileName.length < extension.length + 1) throw invalid('File name and selected document type must match.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const discriminator = workflowHash([sha256, input.mimeType, input.expectedFingerprint]);
  const id = workflowHash(['job.document_imported', input.jobId, input.expectedRevision, discriminator]);
  // Authorize before parsing; do not hold the workspace lock while a parser runs.
  const prior = await withWorkspaceTransaction(ownerId, async tx => {
    const d = await jobIntakeInTransaction(tx, ownerId, input.jobId); current(d, input);
    const rows = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventKey, id))).limit(1);
    return rows[0] ? describe(rows[0], d) : null;
  });
  if (prior) return { ...prior, alreadyExists: true };
  const scan = scanDocumentBytes(bytes, input.mimeType, sha256);
  if (!scan.clean) throw invalid('Document check rejected this file: ' + scan.reason);
  let sourceText: string;
  try {
    sourceText = await extractDocumentText(bytes, input.mimeType, { maxChars: 50000, rejectOverflow: true, maxPdfPages: 100, strictDocx: true });
  } catch {
    throw invalid('No usable document text could be imported. Use a valid text-based PDF (up to 100 pages), DOCX or UTF-8 TXT within 50000 extracted characters. Scanned images require OCR; encrypted or unsupported files need conversion.');
  }
  if (sourceText.length < 40) throw invalid('Document contains fewer than 40 readable characters. Scanned images require OCR or a text-based version.');
  // The existing ledger retains text and provenance, never the uploaded file or base64.
  return withWorkspaceTransaction(ownerId, async tx => {
    const d = await jobIntakeInTransaction(tx, ownerId, input.jobId); current(d, input);
    const existing = (await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventKey, id))).limit(1))[0];
    if (existing) return { ...describe(existing, d), alreadyExists: true };
    const metadata = { fileName, mimeType: input.mimeType, sha256, sizeBytes: bytes.length, sourceText, textHash: workflowHash(sourceText), baseFingerprint: d.editFingerprint, actorId, rawFileRetained: false, formatChecks: 'passed', comprehensiveMalwareScan: false };
    await appendWorkflowEvent(tx, ownerId, 'job.document_imported', input.jobId, d.revision, metadata, discriminator);
    await recordAudit({ ownerId, actorType: 'user', actorId: String(actorId), action: 'job.document_imported', resourceType: 'job', resourceId: input.jobId, metadata: { documentImportId: id, sha256, textHash: metadata.textHash, sizeBytes: bytes.length } }, tx);
    return { ...describe({ eventKey: id, revision: d.revision, metadata }, d), alreadyExists: false };
  });
}
export async function listJobDocuments(ownerId: number, jobId: string) {
  return withWorkspaceTransaction(ownerId, async tx => {
    const d = await jobIntakeInTransaction(tx, ownerId, jobId);
    const rows = await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId, ownerId), eq(workflowEvents.eventType, 'job.document_imported'), eq(workflowEvents.aggregateId, jobId))).orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id)).limit(5);
    return rows.map(row => describe(row, d));
  });
}

export async function checkJobDocumentSource(tx: any, ownerId: number, jobId: string, revision: number, fingerprint: string, id: string, text: string) {
  const row = await findJobDocument(tx, ownerId, id);
  if (row.aggregateId !== jobId || row.revision !== revision || row.metadata.baseFingerprint !== fingerprint) throw invalid('Document belongs to a different requirement snapshot. Import it against the current draft.', 'CONFLICT');
  if (workflowHash(row.metadata.sourceText) !== row.metadata.textHash || !row.metadata.sourceText.includes(text)) throw invalid('Use an unchanged complete excerpt of this document, or clear the document link to enter manual source text.', 'CONFLICT');
  return { documentImportId: id, documentSha256: row.metadata.sha256 as string, documentName: row.metadata.fileName as string };
}
