const formatters = new Map<string, Intl.DateTimeFormat>();
export function validateTimezone(timezone: string) {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  return timezone;
}

export function localClock(now: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), weekend: parts.weekday === "Sat" || parts.weekday === "Sun" };
}

function minuteOfDay(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Quiet hours must use a valid 24-hour HH:mm time.");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function nextContactTime(now: Date, input: { timezone: string; quietStart: string; quietEnd: string; businessDaysOnly?: boolean; nextDay?: boolean }) {
  validateTimezone(input.timezone);
  const start = minuteOfDay(input.quietStart), end = minuteOfDay(input.quietEnd);
  const initialDay = localClock(now, input.timezone).day;
  for (let offset = 0; offset <= 8 * 24 * 60; offset++) {
    const at = offset === 0 ? new Date(now) : new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + (offset - 1) * 60_000);
    const local = localClock(at, input.timezone);
    if (input.nextDay && local.day === initialDay) continue;
    if (input.businessDaysOnly && local.weekend) continue;
    const quiet = start === end ? false : start < end ? local.minute >= start && local.minute < end : local.minute >= start || local.minute < end;
    if (!quiet) return at;
  }
  throw new Error("No permitted contact window was found within eight days.");
}
