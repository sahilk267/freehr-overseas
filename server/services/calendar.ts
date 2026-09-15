export type CalendarEventInput = {
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  organizerEmail?: string | null;
  attendeeEmail?: string | null;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
};

function escapeIcsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([;,])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

function formatUtc(date: Date) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldLine(line: string) {
  const chunks: string[] = [];
  for (let index = 0; index < line.length; index += 74) chunks.push(index === 0 ? line.slice(index, index + 75) : ` ${line.slice(index, index + 74)}`);
  return chunks.join("\r\n");
}

function property(name: string, value: string | null | undefined) {
  return value ? foldLine(`${name}:${escapeIcsText(value)}`) : null;
}

export function createInterviewIcs(input: CalendarEventInput) {
  if (input.end.getTime() <= input.start.getTime()) throw new Error("Calendar event end must be after start.");
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//FreelanceHR//Provider-Free Interview Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(input.uid)}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DTSTART:${formatUtc(input.start)}`,
    `DTEND:${formatUtc(input.end)}`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
    `STATUS:${input.status ?? "CONFIRMED"}`,
    property("SUMMARY", input.summary),
    property("DESCRIPTION", input.description),
    property("LOCATION", input.location),
    input.organizerEmail ? `ORGANIZER:mailto:${input.organizerEmail.trim()}` : null,
    input.attendeeEmail ? `ATTENDEE;RSVP=TRUE:mailto:${input.attendeeEmail.trim()}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function createInterviewEventUid(interviewId: string) {
  return `interview-${interviewId}@freelancehr.overseasjob.in`;
}

export function calendarContentDisposition(interviewId: string) {
  return `attachment; filename="freelancehr-interview-${interviewId}.ics"`;
}

export { escapeIcsText, formatUtc };
