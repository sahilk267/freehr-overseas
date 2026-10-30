import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { interviews } from "../../drizzle/schema";
import { requireDb } from "../db";
import { authenticateRuntimeRequest } from "./runtimeAuth";
import { createInterviewEventUid, generateCalendarFeedIcs } from "./calendar";

function subscriptionKey() {
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Calendar subscriptions require a configured session signing key." });
  return new TextEncoder().encode(secret);
}

// Subscription access expires and is invalidated when the session signing key rotates.
export async function createCalendarSubscriptionToken(ownerId: number) {
  return new SignJWT({ scope: "calendar:read" }).setProtectedHeader({ alg: "HS256" })
    .setSubject(String(ownerId)).setAudience("freelancehr-calendar").setIssuedAt()
    .setExpirationTime("7d").sign(subscriptionKey());
}

export function interviewCalendarEvent(item: typeof interviews.$inferSelect) {
  const start = item.scheduledAt instanceof Date ? item.scheduledAt : new Date(String(item.scheduledAt));
  return {
    uid: createInterviewEventUid(item.id), sequence: item.calendarSequence,
    start,
    end: new Date(start.getTime() + (item.durationMinutes ?? 45) * 60_000),
    summary: "FreelanceHR interview",
    // Internal preparation notes never belong in a subscription feed.
    location: item.meetingUrl,
    status: (item.status === "cancelled" ? "CANCELLED" : item.calendarStatus === "confirmed" ? "CONFIRMED" : "TENTATIVE") as "CANCELLED" | "CONFIRMED" | "TENTATIVE",
  };
}

export async function readAuthorizedCalendarFeed(rawOwnerId: string, token: unknown, request: { headers?: { cookie?: string } }) {
  if (!/^[1-9]\d{0,9}$/.test(rawOwnerId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid user ID" });
  const ownerId = Number(rawOwnerId);
  if (typeof token === "string" && token) {
    try {
      const { payload } = await jwtVerify(token, subscriptionKey(), { algorithms: ["HS256"], audience: "freelancehr-calendar" });
      if (payload.sub !== rawOwnerId || payload.scope !== "calendar:read") throw new Error("Invalid scope");
    } catch {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Calendar subscription is invalid or expired." });
    }
  } else {
    const user = await authenticateRuntimeRequest(request);
    if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Calendar authentication required." });
    if (user.id !== ownerId) throw new TRPCError({ code: "FORBIDDEN", message: "Calendar access denied." });
  }
  const db = await requireDb();
  const rows = await db.select().from(interviews).where(eq(interviews.ownerId, ownerId)).orderBy(interviews.scheduledAt).limit(200);
  return generateCalendarFeedIcs(rows.filter((row: typeof interviews.$inferSelect) => row.scheduledAt).map(interviewCalendarEvent));
}

export function calendarErrorStatus(error: unknown) {
  return error instanceof TRPCError ? ({ BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403 }[error.code] ?? 500) : 500;
}
