import { createHash } from "crypto";
import { and, desc, eq } from "drizzle-orm";
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
    if (process.env.DATABASE_URL) {
      try {
        _db = drizzle(process.env.DATABASE_URL);
      } catch (err) {
        console.warn("[FreelanceHR] Failed to connect to DATABASE_URL, using in-memory store:", err);
        _db = createMockDrizzle(_mockStore);
      }
    } else {
      _db = createMockDrizzle(_mockStore);
    }
  }
  return _db;
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
