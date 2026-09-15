import { describe, expect, it } from "vitest";
import { reminderAtFor, reminderIdempotencyKey } from "./interviewReminders";

describe("interview reminder scheduling", () => {
  it("calculates the reminder from the stored UTC instant", () => {
    const scheduled = new Date("2026-09-01T10:00:00.000Z");
    expect(reminderAtFor(scheduled).toISOString()).toBe("2026-08-31T10:00:00.000Z");
    expect(reminderAtFor(scheduled, 2).toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("creates a stable key for retries and reschedules", () => {
    const scheduled = new Date("2026-09-01T10:00:00.000Z");
    expect(reminderIdempotencyKey("int_1", scheduled)).toBe("interview-reminder:int_1:1788256800000");
    expect(reminderIdempotencyKey("int_1", null)).toBe("interview-reminder:int_1:none");
    expect(reminderIdempotencyKey("int_1", scheduled)).toBe(reminderIdempotencyKey("int_1", new Date(scheduled)));
  });
});
