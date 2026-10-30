import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "../../shared/money";

describe("currency-aware receipt amounts", () => {
  it("preserves exact minor-unit amounts without floating-point rounding", () => {
    expect(parseMoney("0.29", "INR")).toBe(29);
    expect(parseMoney("1000.50", "INR")).toBe(100050);
    expect(parseMoney("5", "JPY")).toBe(5);
    expect(parseMoney("1.234", "KWD")).toBe(1234);
    expect(formatMoney(100050, "INR")).toContain("1,000.50");
  });
  it.each(["-1", "0", "1e3", "1,000", "0.001", "99999999999999"])("rejects invalid or unsupported receipt amount %s", amount => {
    expect(() => parseMoney(amount, "INR")).toThrow();
  });
});
