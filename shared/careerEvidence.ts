import { z } from "zod";

/** Literal source statements only; dates are parsed deterministically after extraction. */
export const careerRecordSchema = z
  .object({
    kind: z.enum(["employment", "education", "certification", "skill"]),
    title: z.string().trim().min(1).max(200),
    organization: z.string().trim().min(1).max(200).nullable().default(null),
    startText: z.string().trim().min(1).max(80).nullable().default(null),
    endText: z.string().trim().min(1).max(80).nullable().default(null),
    current: z.boolean().default(false),
    quote: z.string().min(3).max(1200),
    confidence: z.number().int().min(0).max(100),
  })
  .strict();
export const careerRecordsSchema = z.array(careerRecordSchema).max(24);
export type CareerRecord = z.infer<typeof careerRecordSchema>;
export type CareerDate = {
  text: string;
  precision: "year" | "month" | "day";
  firstMonth: number;
  lastMonth: number;
  iso: string;
};
export type GroundedCareerRecord = CareerRecord & {
  id: string;
  supported: boolean;
  reasons: string[];
  citation: {
    start: number;
    end: number;
    unit: "utf16_code_unit";
    page: null;
  } | null;
  start: CareerDate | null;
  end: CareerDate | null;
};
export type CareerIssue = {
  id: string;
  kind:
    | "unsupported"
    | "date_unknown"
    | "date_order"
    | "future_date"
    | "overlap"
    | "gap";
  recordIds: string[];
  explanation: string;
  question: string | null;
};

const monthNames = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
/** No locale-ambiguous numeric date guessing, century expansion or language inference. */
export function parseCareerDate(text: string | null): CareerDate | null {
  if (!text) return null;
  const s = text.trim();
  let year: number, month: number | undefined, day: number | undefined;
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  const named = /^(?:([0-3]?\d)\s+)?([A-Za-z]+)[\s,]+(\d{4})$/.exec(s);
  if (iso) {
    year = +iso[1];
    month = iso[2] ? +iso[2] : undefined;
    day = iso[3] ? +iso[3] : undefined;
  } else if (
    named &&
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i.test(
      named[2]
    )
  ) {
    year = +named[3];
    month = monthNames.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    day = named[1] ? +named[1] : undefined;
  } else return null;
  if (
    year < 1900 ||
    year > 2200 ||
    (month !== undefined && (month < 1 || month > 12))
  )
    return null;
  if (
    day !== undefined &&
    (!month || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
  )
    return null;
  return {
    text,
    precision:
      day !== undefined ? "day" : month !== undefined ? "month" : "year",
    firstMonth: year * 12 + (month ? month - 1 : 0),
    lastMonth: year * 12 + (month ? month - 1 : 11),
    iso:
      String(year) +
      (month ? "-" + String(month).padStart(2, "0") : "") +
      (day !== undefined ? "-" + String(day).padStart(2, "0") : ""),
  };
}

const unionMonths = (intervals: [number, number][]) => {
  let total = 0,
    end = -Infinity;
  for (const [start, finish] of intervals
    .filter(([a, b]) => a <= b)
    .sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end + 1) + 1);
    end = Math.max(end, finish);
  }
  return total;
};
export function analyzeCareerRecords(
  records: GroundedCareerRecord[],
  observedAt: string
) {
  const asOf = new Date(observedAt),
    nowMonth = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
  if (!Number.isFinite(asOf.getTime()))
    throw Error("A valid observation date is required.");
  const issues: CareerIssue[] = [];
  const add = (
    kind: CareerIssue["kind"],
    ids: string[],
    explanation: string,
    question: string | null
  ) =>
    issues.push({
      id: kind + ":" + [...ids].sort().join(":"),
      kind,
      recordIds: ids,
      explanation,
      question,
    });
  const intervals: {
    record: GroundedCareerRecord;
    start: CareerDate;
    end: CareerDate;
  }[] = [];
  for (const r of records) {
    if (!r.supported) {
      add(
        "unsupported",
        [r.id],
        "This extracted record lacks an unambiguous supporting source span or literal field evidence.",
        null
      );
      continue;
    }
    if (r.kind !== "employment") continue;
    const end = r.current
      ? {
          text: "observed current",
          precision: "month" as const,
          firstMonth: nowMonth,
          lastMonth: nowMonth,
          iso: asOf.toISOString().slice(0, 7),
        }
      : r.end;
    if (!r.start || !end) {
      add(
        "date_unknown",
        [r.id],
        "Employment dates are absent or use an unsupported/ambiguous date format. No dates or experience duration were invented.",
        "If relevant to this role, please clarify the employment dates for the referenced CV entry. You may state that dates are unavailable."
      );
      continue;
    }
    if (
      r.start.firstMonth > nowMonth ||
      (r.start.precision === "day" &&
        r.start.iso > asOf.toISOString().slice(0, 10)) ||
      (!r.current &&
        (end.firstMonth > nowMonth ||
          (end.precision === "day" &&
            end.iso > asOf.toISOString().slice(0, 10))))
    ) {
      add(
        "future_date",
        [r.id],
        "A future employment date needs clarification; it is excluded from observed work coverage.",
        "Does the referenced future date describe an intended engagement or a date that needs correction?"
      );
      continue;
    }
    if (r.start.firstMonth > end.lastMonth) {
      add(
        "date_order",
        [r.id],
        "The stated start falls after the stated end.",
        "Please check the order of the employment dates in the referenced CV entry."
      );
      continue;
    }
    intervals.push({ record: r, start: r.start, end });
  }
  const sorted = [...intervals].sort(
    (a, b) =>
      a.start.firstMonth - b.start.firstMonth ||
      a.end.lastMonth - b.end.lastMonth
  );
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i],
        b = sorted[j];
      if (
        Math.max(a.start.lastMonth, b.start.lastMonth) <=
        Math.min(a.end.firstMonth, b.end.firstMonth)
      )
        add(
          "overlap",
          [a.record.id, b.record.id],
          "These employment month ranges definitely overlap. Parallel employment, projects or imprecise dates may be legitimate; no adverse conclusion is inferred.",
          "If relevant, clarify whether the referenced entries were concurrent roles, projects or dates that need correction."
        );
    }
  // Gaps are measured against the union, so a concurrent role cannot create a false gap.
  let coverageEnd = -Infinity,
    previous: (typeof sorted)[number] | undefined;
  for (const entry of sorted) {
    if (previous && entry.start.firstMonth > coverageEnd + 1)
      add(
        "gap",
        [previous.record.id, entry.record.id],
        "There are uncovered months between the stated employment ranges. This is a source-completeness question, not a negative employment signal.",
        "If useful for this role, would you like to add or correct job-related chronology for the interval between these entries? Personal reasons are not required."
      );
    if (entry.end.lastMonth > coverageEnd) {
      coverageEnd = entry.end.lastMonth;
      previous = entry;
    }
  }
  const minimum = unionMonths(
      intervals.map(i => [i.start.lastMonth, i.end.firstMonth])
    ),
    maximum = unionMonths(
      intervals.map(i => [
        i.start.firstMonth,
        Math.min(i.end.lastMonth, nowMonth),
      ])
    );
  return {
    issues,
    coverageMonths: {
      minimum,
      maximum,
      meaning:
        "Union of stated employment month ranges, not verified tenure or relevant experience; partial months and current-role observation are approximate.",
    },
    employmentRecords: intervals.length,
    observedAt,
    finalDisposition: false as const,
    independentlyVerified: false as const,
  };
}
