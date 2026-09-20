import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireDb } from "../db";
import { companies } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { recruitmentRouter } from "./recruitment";

describe("company KYB document upload and verification workflow", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PRIVATE_STORAGE_MODE: "local",
      PRIVATE_LOCAL_STORAGE_PATH: `/tmp/freelancehr-test-kyb-${process.pid}`,
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const ownerCtx = {
    user: { id: 1, role: "admin", name: "Owner", email: "owner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = recruitmentRouter.createCaller(ownerCtx);

  it("allows attaching KYB verification documents and transitioning verificationState", async () => {
    const db = await requireDb();
    const companyId = `cmp_kyb_${Date.now()}`;

    await db.insert(companies).values({
      id: companyId,
      ownerId: 1,
      name: "Global Fintech Corp",
      domain: `fintech-${Date.now()}.com`,
      companyType: "prospect",
      pipelineState: "new",
      verificationState: "pending",
    });

    // 1. Attach KYB document (e.g. GST certificate)
    const dummyCert = Buffer.from("PDF DUMMY GST CERTIFICATE CONTENT").toString("base64");
    const attachResult = await caller.prospects.attachKybDocument({
      companyId,
      originalName: "gst_certificate_2026.pdf",
      mimeType: "application/pdf",
      dataBase64: dummyCert,
      documentType: "tax_id_gst",
    });

    expect(attachResult.success).toBe(true);
    expect(attachResult.verificationState).toBe("in_review");
    expect(attachResult.storageKey).toContain("kyb/gst_certificate_2026.pdf");

    // Verify company state in DB
    let [comp] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(comp.verificationState).toBe("in_review");

    // 2. Perform KYB verification
    const verifyResult = await caller.prospects.verifyKyb({
      companyId,
      decision: "verified",
      notes: "Incorporation and GST filing cross-referenced with MCA portal.",
    });

    expect(verifyResult.success).toBe(true);
    expect(verifyResult.verificationState).toBe("verified");

    [comp] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(comp.verificationState).toBe("verified");
    expect(comp.onboardingApprovedAt).toBeInstanceOf(Date);
    expect(comp.onboardingApprovedById).toBe(1);
  });
});
