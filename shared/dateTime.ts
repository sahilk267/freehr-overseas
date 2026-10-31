function wallTime(date: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; }
  catch { return false; }
}

export function formatZonedDateTime(date: Date, timezone: string) {
  return wallTime(date, timezone);
}

/** Interpret a datetime-local value in its explicitly selected timezone. */
export function zonedDateTimeToUtc(value: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid date and time.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 16) !== value) throw new Error("Enter a valid date and time.");
  const offsets = new Set<number>();
  for (const delta of [-2, -1, 0, 1, 2]) {
    const probe = wall + delta * 86400000;
    const local = wallTime(new Date(probe), timezone);
    offsets.add(Date.parse(`${local}:00Z`) - probe);
  }
  const matches = [...offsets].map(offset => new Date(wall - offset)).filter(date => wallTime(date, timezone) === value);
  if (matches.length !== 1) throw new Error("This local time is ambiguous or unavailable because the timezone changes. Choose another time.");
  return matches[0];
}
