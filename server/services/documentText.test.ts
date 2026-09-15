import { describe, expect, it } from "vitest";
import { extractDocumentText } from "./documentText";

describe("candidate document extraction", () => {
  it("normalizes and bounds plain-text CV content before it reaches an AI prompt", async () => {
    const text = await extractDocumentText(Buffer.from("Senior Engineer\n\nTypeScript   APIs"), "text/plain");
    expect(text).toBe("Senior Engineer TypeScript APIs");
  });

  it("rejects documents without extractable text", async () => {
    await expect(extractDocumentText(Buffer.from("   \n\t"), "text/plain")).rejects.toThrow("No extractable text");
  });
});
