import { describe, expect, it } from "vitest";
import { formatZonedDateTime, zonedDateTimeToUtc } from "../../shared/dateTime";

describe("explicit timezone date entry", () => {
  it("interprets India, summer and winter times independently of browser timezone", () => {
    expect(zonedDateTimeToUtc("2026-11-02T09:00", "Asia/Kolkata").toISOString()).toBe("2026-11-02T03:30:00.000Z");
    expect(zonedDateTimeToUtc("2026-07-02T09:00", "America/New_York").toISOString()).toBe("2026-07-02T13:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-12-02T09:00", "America/New_York").toISOString()).toBe("2026-12-02T14:00:00.000Z");
    expect(formatZonedDateTime(new Date("2026-11-02T03:30:00Z"), "Asia/Kolkata")).toBe("2026-11-02T09:00");
  });
  it("rejects nonexistent or ambiguous DST times and invalid calendar values", () => {
    for (const value of ["2026-03-08T02:30", "2026-11-01T01:30"]) expect(() => zonedDateTimeToUtc(value, "America/New_York")).toThrow(/ambiguous or unavailable/);
    expect(() => zonedDateTimeToUtc("2026-02-30T09:00", "UTC")).toThrow();
    expect(() => zonedDateTimeToUtc("2026-01-01T09:00", "Invalid/Timezone")).toThrow();
  });
});
