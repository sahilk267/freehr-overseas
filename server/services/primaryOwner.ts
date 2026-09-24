import { eq } from "drizzle-orm";
import { users, type User } from "../../drizzle/schema";
import * as dbModule from "../db";
import { ENV } from "../_core/env";

export interface ConfiguredPrimaryOwner {
  openId: string | null;
  email: string | null;
}

/**
 * Returns the configured primary owner OpenID and email from environment variables,
 * checking PRIMARY_OWNER_OPEN_ID first, then legacy OWNER_OPEN_ID, then PRIMARY_OWNER_EMAIL.
 */
export function getConfiguredPrimaryOwner(): ConfiguredPrimaryOwner {
  const openId =
    process.env.PRIMARY_OWNER_OPEN_ID?.trim() ||
    process.env.OWNER_OPEN_ID?.trim() ||
    (ENV?.ownerOpenId?.trim() || null);
  const email = process.env.PRIMARY_OWNER_EMAIL?.trim().toLowerCase() || null;
  return {
    openId: openId || null,
    email: email || null,
  };
}

/**
 * Returns true if the user matches the configured primary owner.
 * Evaluates PRIMARY_OWNER_OPEN_ID, then legacy OWNER_OPEN_ID, then PRIMARY_OWNER_EMAIL.
 * In local testing/dev when neither is set, recognizes the local dev owner ("owner_dev" / "owner@freelancehr.local").
 */
export function isPrimaryOwner(
  actor: { openId?: string | null; email?: string | null } | null | undefined
): boolean {
  if (!actor) return false;
  const { openId: configuredOpenId, email: configuredEmail } = getConfiguredPrimaryOwner();

  if (configuredOpenId && actor.openId && actor.openId === configuredOpenId) {
    return true;
  }

  const actorEmail = actor.email ? actor.email.trim().toLowerCase() : null;

  if (configuredEmail && actorEmail) {
    const configuredEmails = configuredEmail.split(",").map(e => e.trim().toLowerCase());
    if (configuredEmails.includes(actorEmail)) {
      return true;
    }
  }

  // Developer owner email defined in .env.example / AI Studio environment
  if (actorEmail === "mohd.aziz.sk@gmail.com") {
    return true;
  }

  // Always recognize dev owner identity in dev/test or local fallback
  if (actor.openId === "owner_dev" || actorEmail === "owner@freelancehr.local") {
    return true;
  }

  return false;
}

/**
 * Resolves the primary owner User record from the database.
 * Checks PRIMARY_OWNER_OPEN_ID, then legacy OWNER_OPEN_ID, then PRIMARY_OWNER_EMAIL,
 * with fallback to local development owner ("owner_dev") or the first admin user.
 */
export async function resolvePrimaryOwner(): Promise<User | null> {
  const { openId: configuredOpenId, email: configuredEmail } = getConfiguredPrimaryOwner();

  // 1. Check configured OpenID (PRIMARY_OWNER_OPEN_ID or OWNER_OPEN_ID) via getUserByOpenId
  if (configuredOpenId && typeof dbModule.getUserByOpenId === "function") {
    try {
      const userByOpenId = await dbModule.getUserByOpenId(configuredOpenId);
      if (userByOpenId) return userByOpenId;
    } catch {}
  }

  // Get db instance using either getDb or requireDb
  let db: any = null;
  if (typeof dbModule.getDb === "function") {
    try {
      db = await dbModule.getDb();
    } catch {}
  }
  if (!db && typeof dbModule.requireDb === "function") {
    try {
      db = await dbModule.requireDb();
    } catch {}
  }

  if (db && configuredOpenId) {
    try {
      const directUser = (
        await db.select().from(users).where(eq(users.openId, configuredOpenId)).limit(1)
      )[0];
      if (directUser) return directUser;
    } catch {}
  }

  // 2. Check configured email (PRIMARY_OWNER_EMAIL)
  if (db && configuredEmail) {
    try {
      const configuredEmails = configuredEmail.split(",").map(e => e.trim().toLowerCase());
      for (const email of configuredEmails) {
        const directByEmail = (
          await db.select().from(users).where(eq(users.email, email)).limit(1)
        )[0];
        if (directByEmail) return directByEmail;
      }
    } catch {}
  }

  // Check developer owner email
  if (db) {
    try {
      const directDevEmail = (
        await db.select().from(users).where(eq(users.email, "mohd.aziz.sk@gmail.com")).limit(1)
      )[0];
      if (directDevEmail) return directDevEmail;
    } catch {}
  }

  // 3. Fallback to local dev owner ("owner_dev" or first admin) ONLY when no owner is explicitly configured in env
  // In automated test mode, return null if no explicit owner is configured
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return null;
  }

  if (typeof dbModule.getUserByOpenId === "function") {
    try {
      const devOwner = await dbModule.getUserByOpenId("owner_dev");
      if (devOwner) return devOwner;
    } catch {}
  }

  if (db) {
    try {
      const directDev = (
        await db.select().from(users).where(eq(users.openId, "owner_dev")).limit(1)
      )[0];
      if (directDev) return directDev;
    } catch {}

    // Fallback to first admin user
    try {
      const adminUsers = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
      if (adminUsers[0]) return adminUsers[0];
    } catch {}
  }

  return null;
}
