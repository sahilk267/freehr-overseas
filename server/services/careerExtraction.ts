import { createHash } from "node:crypto";
import {
  careerRecordsSchema,
  parseCareerDate,
  type GroundedCareerRecord,
} from "../../shared/careerEvidence";
import { ensureSafeAiText } from "../workflow";
export const CAREER_PARSER_VERSION = "literal-career-v1";
export const careerTextHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const careerDocumentSourceHash = (d: any) =>
  careerTextHash(
    JSON.stringify([
      d.id,
      d.candidateId,
      d.storageKey,
      d.sha256 ?? null,
      d.mimeType,
      d.scanState,
      (d.parsedData as any)?.careerEvidence?.integrityHash ?? null,
      (d.provenance as any)?.supersededBy ?? null,
    ])
  );
export function groundCareerRecords(text: string, raw: unknown) {
  const records = careerRecordsSchema.parse(raw),
    seen = new Set<string>(),
    result: GroundedCareerRecord[] = [];
  for (const r of records) {
    const reasons: string[] = [],
      start = text.indexOf(r.quote),
      unique = start >= 0 && text.indexOf(r.quote, start + 1) < 0;
    if (!unique)
      reasons.push(
        start < 0
          ? "Supporting quote is absent from the extracted source."
          : "Supporting quote occurs more than once; the span is ambiguous."
      );
    for (const [field, value] of Object.entries({
      title: r.title,
      organization: r.organization,
      startText: r.startText,
      endText: r.endText,
    }))
      if (
        value &&
        !r.quote
          .toLocaleLowerCase("en-US")
          .includes(value.toLocaleLowerCase("en-US"))
      )
        reasons.push(
          "The " + field + " value is absent from its supporting quote."
        );
    if (
      r.current &&
      (!/\b(present|current(?:ly)?|ongoing)\b/i.test(r.quote) || r.endText)
    )
      reasons.push(
        "Current employment requires an explicit current marker and no contradictory end date."
      );
    if (r.current && r.kind !== "employment")
      reasons.push("Only employment records may be marked current.");
    try {
      ensureSafeAiText(
        [r.title, r.organization, r.quote].filter(Boolean).join(" ")
      );
    } catch {
      reasons.push(
        "Protected or prohibited recruitment content must not be used as career evidence."
      );
    }
    const identity = JSON.stringify([
      r.kind,
      r.title.trim().toLowerCase(),
      r.organization?.trim().toLowerCase() ?? null,
      r.startText,
      r.endText,
      r.current,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      ...r,
      id: careerTextHash(identity).slice(0, 24),
      supported: reasons.length === 0,
      reasons,
      citation: unique
        ? {
            start,
            end: start + r.quote.length,
            unit: "utf16_code_unit",
            page: null,
          }
        : null,
      start: parseCareerDate(r.startText),
      end: parseCareerDate(r.endText),
    });
  }
  return result;
}
/** Stable across MySQL JSON key reordering. All source and computed evidence fields are bound. */
export function careerEvidenceIntegrity(c: any) {
  const date = (d: any) =>
    d ? [d.text, d.precision, d.firstMonth, d.lastMonth, d.iso] : null;
  return careerTextHash(
    JSON.stringify([
      c.parserVersion,
      c.sourceTextHash,
      c.documentSourceHash,
      c.documentId,
      c.candidateId,
      c.documentSha256,
      c.model,
      c.observedAt,
      c.records.map((r: any) => [
        r.id,
        r.kind,
        r.title,
        r.organization,
        r.startText,
        r.endText,
        r.current,
        r.quote,
        r.confidence,
        r.supported,
        r.reasons,
        r.citation
          ? [r.citation.start, r.citation.end, r.citation.unit, r.citation.page]
          : null,
        date(r.start),
        date(r.end),
      ]),
    ])
  );
}
