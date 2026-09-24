import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { nanoid } from "nanoid";
import {
  auditEvents,
  type InsertUser,
  type User,
  users,
  workspaceSettings,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getAuditActor } from "./services/actorContext";
import { createMockDrizzle, seedInitialStore } from "./mockDb";
import { isPrimaryOwner, resolvePrimaryOwner, getConfiguredPrimaryOwner } from "./services/primaryOwner";
export { isPrimaryOwner, resolvePrimaryOwner, getConfiguredPrimaryOwner };

let _db: any = null;
const _mockStore = seedInitialStore();

export async function getDb() {
  if (!_db) {
    const isStrictProduction = process.env.NODE_ENV === "production" && !process.env.VITEST;
    const rawUrl = process.env.DATABASE_URL?.trim();
    const hasValidMysqlProtocol = Boolean(rawUrl && /^(mysql|mysql2|mariadb):\/\//i.test(rawUrl));

    if (rawUrl) {
      if (!hasValidMysqlProtocol) {
        if (isStrictProduction) {
          console.error("[FreelanceHR] FATAL: DATABASE_URL format is invalid in production mode.");
          throw new Error("[FreelanceHR] Database configuration error: DATABASE_URL must be a valid MySQL connection URL (e.g. mysql://user:pass@host:3306/db). Refusing to initialize mock database store in production.");
        }
        _db = createMockDrizzle(_mockStore);
      } else {
        try {
          const client = drizzle(rawUrl);
          if (isStrictProduction) {
            await client.execute(sql`SELECT 1`);
          }
          _db = client;
        } catch (err) {
          if (isStrictProduction) {
            console.error("[FreelanceHR] FATAL: Failed to connect to DATABASE_URL in production mode:", err);
            throw new Error("[FreelanceHR] Database connectivity error: Failed to connect to MySQL database. Refusing to initialize mock database store in production.");
          }
          console.warn("[FreelanceHR] Failed to connect to DATABASE_URL, using in-memory store:", (err as Error)?.message || String(err));
          _db = createMockDrizzle(_mockStore);
        }
      }
    } else {
      if (isStrictProduction) {
        console.error("[FreelanceHR] FATAL: DATABASE_URL is missing in production mode.");
        throw new Error("[FreelanceHR] Database configuration error: DATABASE_URL environment variable is missing. Refusing to initialize mock database store in production.");
      }
      _db = createMockDrizzle(_mockStore);
    }
  }
  return _db;
}

export function _resetDbForTesting() {
  _db = null;
}

export async function verifyDatabaseConnectivity(): Promise<{ connected: boolean; error?: string }> {
  try {
    const isStrictProduction = process.env.NODE_ENV === "production" && !process.env.VITEST;
    if (isStrictProduction && !process.env.DATABASE_URL) {
      return { connected: false, error: "[FreelanceHR] Database configuration error: DATABASE_URL environment variable is missing in production mode." };
    }
    const db = await getDb();
    await db.execute(sql`SELECT 1`);
    return { connected: true };
  } catch (err: any) {
    return { connected: false, error: err?.message || String(err) };
  }
}

export async function requireDb() {
  return getDb();
}

export function createId(prefix = "") {
  return `${prefix}${nanoid(20)}`.slice(0, 36);
}

export function hashContactValue(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await requireDb();
  const values: InsertUser = { ...user, openId: user.openId };
  const isConfiguredOwner = isPrimaryOwner(user);
  if (!values.role && isConfiguredOwner) values.role = "admin";
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({
    set: {
      name: values.name,
      email: values.email,
      loginMethod: values.loginMethod,
      role: values.role,
      lastSignedIn: values.lastSignedIn,
    },
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function ensureWorkspace(ownerId: number) {
  const db = await requireDb();
  const existing = await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(workspaceSettings).values({ ownerId });
  const created = await db.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1);
  return created[0]!;
}

export async function recordAudit(input: {
  ownerId: number;
  actorType: "user" | "ai" | "system" | "cron" | "provider";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState?: string | null;
  nextState?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = await requireDb();
  const id = createId("aud_");
  const requestActor = getAuditActor();
  const actorId = input.actorType === "user" && requestActor ? String(requestActor.userId) : input.actorId ?? null;
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.actorType === "user" && requestActor && requestActor.userId !== input.ownerId ? { actingRole: requestActor.role, actingForOwnerId: requestActor.workspaceOwnerId } : {}),
  };
  await db.insert(auditEvents).values({
    id,
    ownerId: input.ownerId,
    actorType: input.actorType,
    actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    previousState: input.previousState ?? null,
    nextState: input.nextState ?? null,
    metadata,
  });
  return id;
}

export async function getRecentAudits(ownerId: number, limit = 12) {
  const db = await requireDb();
  return db.select().from(auditEvents).where(eq(auditEvents.ownerId, ownerId)).orderBy(desc(auditEvents.createdAt)).limit(limit);
}

export type CurrentUser = User;
