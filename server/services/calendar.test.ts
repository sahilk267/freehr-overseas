import { describe, expect, it } from "vitest";
import { createInterviewEventUid, createInterviewIcs, escapeIcsText, formatUtc } from "./calendar";

describe("provider-free interview calendar", () => {
  it("escapes ICS text and emits CRLF-terminated UTC fields", () => {
    const start = new Date("2026-09-01T10:00:00.000Z");
    const content = createInterviewIcs({ uid: "int_123", sequence: 2, start, end: new Date("2026-09-01T10:45:00.000Z"), summary: "API, platform; review", description: "Line one\nLine two", status: "CONFIRMED" });
    expect(content).toContain("SUMMARY:API\\, platform\\; review");
    expect(content).toContain("DESCRIPTION:Line one\\nLine two");
    expect(content).toContain("DTSTART:20260901T100000Z");
    expect(content).toContain("SEQUENCE:2");
    expect(content.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("supports cancellation status and stable event identifiers", () => {
    expect(createInterviewEventUid("int_abc")).toBe("interview-int_abc@freelancehr.overseasjob.in");
    const content = createInterviewIcs({ uid: createInterviewEventUid("int_abc"), sequence: 3, start: new Date("2026-09-01T10:00:00Z"), end: new Date("2026-09-01T10:30:00Z"), summary: "Interview", status: "CANCELLED" });
    expect(content).toContain("STATUS:CANCELLED");
    expect(escapeIcsText("a\\b,c;d")).toBe("a\\\\b\\,c\\;d");
    expect(formatUtc(new Date("2026-09-01T10:00:00Z"))).toBe("20260901T100000Z");
  });

  it("rejects an invalid event range", () => {
    expect(() => createInterviewIcs({ uid: "int_bad", sequence: 0, start: new Date("2026-09-01T10:00:00Z"), end: new Date("2026-09-01T10:00:00Z"), summary: "Interview" })).toThrow("end must be after start");
  });
});
