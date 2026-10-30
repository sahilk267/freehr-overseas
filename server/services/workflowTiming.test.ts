import { describe, expect, it } from "vitest";
import { localClock, nextContactTime } from "./workflowTiming";
const window = { timezone: "UTC", quietStart: "20:00", quietEnd: "08:00" };
describe("contact windows", () => {
  it("keeps an open instant and advances a quiet instant to the first permitted minute", () => {
    expect(nextContactTime(new Date("2026-10-28T12:00:30Z"), window).toISOString()).toBe("2026-10-28T12:00:30.000Z");
    expect(nextContactTime(new Date("2026-10-28T07:59:30Z"), window).toISOString()).toBe("2026-10-28T08:00:00.000Z");
    expect(nextContactTime(new Date("2026-10-28T20:00:00Z"), window).toISOString()).toBe("2026-10-29T08:00:00.000Z");
  });
  it("moves Friday evening across the weekend", () => {
    expect(nextContactTime(new Date("2026-10-30T20:00:00Z"), { ...window, businessDaysOnly: true }).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });
  it("resolves a spring DST gap using actual instants", () => {
    expect(nextContactTime(new Date("2026-03-08T06:59:30Z"), { timezone: "America/New_York", quietStart: "20:00", quietEnd: "02:30" }).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
  it("resolves the repeated fall-back hour and a next local day", () => {
    expect(nextContactTime(new Date("2026-11-01T05:45:00Z"), { timezone: "America/New_York", quietStart: "01:30", quietEnd: "02:30" }).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    const next = nextContactTime(new Date("2026-10-28T23:30:00Z"), { timezone: "Asia/Kolkata", quietStart: "00:00", quietEnd: "00:00", nextDay: true });
    expect(localClock(next, "Asia/Kolkata").day).toBe("2026-10-30");
  });
  it("rejects invalid quiet hours and timezones", () => {
    expect(() => nextContactTime(new Date(), { ...window, quietStart: "25:00" })).toThrow();
    expect(() => nextContactTime(new Date(), { ...window, timezone: "Invalid/Timezone" })).toThrow();
  });
});
