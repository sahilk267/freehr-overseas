import { useState, type ChangeEvent } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { MAX_JOB_DOCUMENT_BYTES, jobDocumentMimeTypes } from '../../../shared/jobDocument';

type DocumentSource = { documentImportId: string; sourceText: string; fileName: string };
export function JobDocumentImport({ jobId, revision, fingerprint, canImport, onUse }: {
  jobId: string; revision: number; fingerprint: string; canImport: boolean; onUse: (source: DocumentSource) => void;
}) {
  const utils = trpc.useUtils();
  const [file, setFile] = useState<File | null>(null), [reading, setReading] = useState(false);
  const docs = trpc.recruitment.jobs.requirementDocuments.useQuery({ jobId });
  const upload = trpc.recruitment.jobs.importRequirementDocument.useMutation({ onSuccess: async result => {
    await utils.recruitment.jobs.requirementDocuments.invalidate({ jobId });
    toast.success(result.alreadyExists ? 'Existing document import reused.' : 'Document text imported. Review it before extracting facts.');
  } });
  const choose = (e: ChangeEvent<HTMLInputElement>) => { setFile(e.target.files?.[0] ?? null); };
  const importFile = async () => {
    if (!file) return;
    if (file.size < 1 || file.size > MAX_JOB_DOCUMENT_BYTES) { toast.error('Choose a document between 1 byte and 2 MB.'); return; }
    const extension = file.name.toLowerCase().split('.').pop();
    const mimeType = extension === 'pdf' ? jobDocumentMimeTypes[0] : extension === 'docx' ? jobDocumentMimeTypes[1] : extension === 'txt' ? jobDocumentMimeTypes[2] : null;
    if (!mimeType) { toast.error('Choose a PDF, DOCX or TXT document.'); return; }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await upload.mutateAsync({ jobId, expectedRevision: revision, expectedFingerprint: fingerprint, fileName: file.name, mimeType, contentBase64: btoa(binary) });
    } catch (error) { if (!upload.error) toast.error(error instanceof Error ? error.message : 'Document import failed.'); }
    finally { setReading(false); }
  };
  return <section aria-label="JD document import" className="space-y-3 rounded-lg border p-3 text-sm">
    <h5 className="font-semibold">Import JD document text</h5>
    <p className="text-xs text-slate-500">PDF, DOCX or UTF-8 TXT up to 2 MB; up to 100 PDF pages and 50000 extracted characters. Text and file hash are saved privately; the original file is not retained. Image scans need OCR or a text-based version. Import does not change the job or request AI extraction.</p>
    {canImport && <div className="space-y-2"><Label htmlFor={`jd-document-${jobId}`}>JD document file</Label><Input id={`jd-document-${jobId}`} type="file" className="min-w-0 max-w-full" accept=".pdf,.docx,.txt" onChange={choose} disabled={reading || upload.isPending} /><Button type="button" size="sm" variant="outline" onClick={importFile} disabled={!file || reading || upload.isPending}>Import document text</Button></div>}
    {upload.error && <p role="alert" className="break-words text-red-700">{upload.error.message}</p>}
    {docs.error && <p role="alert">{docs.error.message}</p>}
    {docs.data?.map(doc => <div key={doc.documentImportId} className="space-y-2 rounded-md bg-slate-50 p-2">
      <p className="break-words font-medium">{doc.fileName} · {doc.sourceText.length} characters</p>
      <p className="text-xs text-slate-500">Requirement version {doc.baseRevision || 'legacy'} · Original file not retained</p>
      <details><summary className="cursor-pointer">Preview imported document text</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{doc.sourceText}</pre></details>
      {doc.stale ? <p className="text-xs text-amber-800">Intake changed. Import against the current draft before using this document.</p> : <><Button type="button" size="sm" variant="outline" className="h-auto max-w-full whitespace-normal text-left" onClick={() => onUse(doc)} disabled={!canImport}>Use imported text as source</Button>{doc.sourceText.length > 8500 && <p className="text-xs text-amber-800">This source exceeds the extraction limit. Select an unchanged complete excerpt of at most 8500 characters in the source box.</p>}</>}
    </div>)}
  </section>;
}
