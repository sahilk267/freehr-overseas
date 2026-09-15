import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const MAX_EXTRACTED_CHARS = 12_000;

export async function extractDocumentText(bytes: Buffer, mimeType: string) {
  let text = "";
  if (mimeType === "text/plain") {
    text = bytes.toString("utf8");
  } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
  } else if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } else {
    throw new Error("Unsupported document type.");
  }
  const normalized = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("No extractable text was found in this document.");
  return normalized.slice(0, MAX_EXTRACTED_CHARS);
}
