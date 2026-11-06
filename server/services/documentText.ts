import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { inflateRawSync } from "node:zlib";

const MAX_EXTRACTED_CHARS = 12_000;

export type DocumentTextOptions = { maxChars?: number; rejectOverflow?: boolean; maxPdfPages?: number; strictDocx?: boolean };

// Validate bounded ZIP contents before the shared DOCX parser decompresses them.
// This is a format/resource check, not a comprehensive antivirus scan.
export function checkDocxContainer(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error("Invalid DOCX ZIP directory.");
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || !count || count > 256 || start + size !== end) throw new Error("Unsupported or oversized DOCX ZIP directory.");
  let cursor = start, expanded = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid DOCX ZIP entry.");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end) throw new Error("Invalid DOCX ZIP entry length.");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name || names.has(name.toLowerCase()) || /\\|\x00|(^|\/)\.\.(\/|$)|^\//.test(name) || /vba|activex|embeddings|\.bin$/i.test(name)) throw new Error("Unsupported embedded or duplicate DOCX entry.");
    names.add(name.toLowerCase());
    if (flags & 1 || ![0, 8].includes(method) || uncompressed > 5 * 1024 * 1024 || expanded + uncompressed > 8 * 1024 * 1024 || bytes.readUInt16LE(cursor + 34) !== 0) throw new Error("Encrypted or oversized DOCX contents are unsupported.");
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt16LE(offset + 6) !== flags) throw new Error("Invalid DOCX local entry.");
    const localNameLength = bytes.readUInt16LE(offset + 26), dataStart = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 30, offset + 30 + localNameLength).toString("utf8") !== name || dataStart + compressed > start) throw new Error("Invalid DOCX content bounds.");
    const data = bytes.subarray(dataStart, dataStart + compressed);
    const actual = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(uncompressed, 5 * 1024 * 1024)) });
    if (actual.length !== uncompressed) throw new Error("DOCX expanded size does not match its directory.");
    expanded += actual.length;
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end || !names.has("word/document.xml") || !names.has("[content_types].xml")) throw new Error("This ZIP file is not a supported DOCX document.");
}

export async function extractDocumentText(bytes: Buffer, mimeType: string, options: DocumentTextOptions = {}) {
  let text = "";
  if (mimeType === "text/plain") {
    text = options.rejectOverflow ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString("utf8");
  } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (options.strictDocx) checkDocxContainer(bytes);
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
  } else if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      if (options.maxPdfPages && (await parser.getInfo()).total > options.maxPdfPages) throw new Error("Document exceeds the supported PDF page limit.");
      const result = await parser.getText(options.rejectOverflow ? { pageJoiner: '' } : undefined);
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } else {
    throw new Error("Unsupported document type.");
  }
  const normalized = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("No extractable text was found in this document.");
  const limit = options.maxChars ?? MAX_EXTRACTED_CHARS;
  if (options.rejectOverflow && normalized.length > limit) throw new Error("Document text exceeds the supported character limit; provide a shorter complete document.");
  return normalized.slice(0, limit);
}
