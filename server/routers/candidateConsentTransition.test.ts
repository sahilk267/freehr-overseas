import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { candidates, consents } from "../../drizzle/schema";
import { createId, requireDb } from "../db";
import { appRouter } from "../routers";

describe("candidatesRouter.transition consent verification", () => {
  const testOwnerId = 1;
  const ownerCtx = {
    user: { id: testOwnerId, role: "admin", name: "Lead Partner", email: "partner@freelancehr.local" },
    req: {},
    res: {},
  } as never;

  const caller = appRouter.createCaller(ownerCtx);

  it("fails with PRECONDITION_FAILED when transitioning to 'consented' without a granted consent record, and succeeds once grantConsent has been called", async () => {
    const db = await requireDb();

    // 1. Create candidate (initial state: consent_pending)
    const { id: candidateId } = await caller.recruitment.candidates.create({
      fullName: "Ananya Sharma",
      email: `ananya.${Date.now()}@example.com`,
      headline: "Senior Backend Engineer",
    });

    const [initialCandidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(initialCandidate.profileState).toBe("consent_pending");

    // 2. Attempt to transition to "consented" without any consent record
    let transitionError: TRPCError | null = null;
    try {
      await caller.recruitment.candidates.transition({
        id: candidateId,
        state: "consented",
      });
    } catch (err: unknown) {
      transitionError = err as TRPCError;
    }

    expect(transitionError).toBeInstanceOf(TRPCError);
    expect(transitionError?.code).toBe("PRECONDITION_FAILED");
    expect(transitionError?.message).toContain("Explicit candidate consent");

    // Verify profile state remained consent_pending
    const [candidateStillPending] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(candidateStillPending.profileState).toBe("consent_pending");

    // 3. Grant platform_processing consent
    const consentRes = await caller.recruitment.candidates.grantConsent({
      candidateId,
      consentType: "platform_processing",
      noticeVersion: "v1.0",
    });
    expect(consentRes.id).toBeDefined();

    // Verify consent record was created with status granted
    const [savedConsent] = await db
      .select()
      .from(consents)
      .where(and(eq(consents.id, consentRes.id), eq(consents.ownerId, testOwnerId)));
    expect(savedConsent).toBeDefined();
    expect(savedConsent.status).toBe("granted");
    expect(savedConsent.consentType).toBe("platform_processing");

    // 4. Now transition to "consented" succeeds
    const transitionRes = await caller.recruitment.candidates.transition({
      id: candidateId,
      state: "consented",
    });
    expect(transitionRes.success).toBe(true);

    const [consentedCandidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(consentedCandidate.profileState).toBe("consented");
  });

  it("enforces consent verification when transitioning from profile_incomplete to consented", async () => {
    const db = await requireDb();

    // Create candidate in profile_incomplete
    const candidateId = createId("can_");
    await db.insert(candidates).values({
      id: candidateId,
      ownerId: testOwnerId,
      fullName: "Rohan Patel",
      profileState: "profile_incomplete",
      sourceType: "manual",
    });

    // Fails without consent
    await expect(
      caller.recruitment.candidates.transition({
        id: candidateId,
        state: "consented",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Grant consent
    await caller.recruitment.candidates.grantConsent({
      candidateId,
      consentType: "platform_processing",
    });

    // Now transition succeeds
    const res = await caller.recruitment.candidates.transition({
      id: candidateId,
      state: "consented",
    });
    expect(res.success).toBe(true);

    const [updated] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(updated.profileState).toBe("consented");
  });

  it("rejects transition if the only consent record is expired or withdrawn", async () => {
    const db = await requireDb();

    const candidateId = createId("can_");
    await db.insert(candidates).values({
      id: candidateId,
      ownerId: testOwnerId,
      fullName: "Priya Nair",
      profileState: "consent_pending",
      sourceType: "manual",
    });

    // Insert an already-withdrawn consent record
    const withdrawnConsentId = createId("cns_");
    await db.insert(consents).values({
      id: withdrawnConsentId,
      ownerId: testOwnerId,
      candidateId,
      consentType: "platform_processing",
      status: "withdrawn",
      noticeVersion: "v1.0",
      withdrawnAt: new Date(),
    });

    await expect(
      caller.recruitment.candidates.transition({
        id: candidateId,
        state: "consented",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Insert an expired consent record
    const expiredConsentId = createId("cns_");
    await db.insert(consents).values({
      id: expiredConsentId,
      ownerId: testOwnerId,
      candidateId,
      consentType: "platform_processing",
      status: "granted",
      noticeVersion: "v1.0",
      expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
    });

    await expect(
      caller.recruitment.candidates.transition({
        id: candidateId,
        state: "consented",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
