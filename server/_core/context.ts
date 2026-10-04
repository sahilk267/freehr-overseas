import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import type { WorkspaceAccess } from "../services/workspaceAccess";
import { authenticateRuntimeRequest } from "../services/runtimeAuth";
import { getUserByOpenId } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  actor: User | null;
  workspace: WorkspaceAccess | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await authenticateRuntimeRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  // RB-12: Unconditional owner fallback is removed.
  // In production, missing or invalid authentication must fail closed (user remains null).
  // Protected procedures will reject with UNAUTHORIZED (401).
  // In non-production, only fall back if explicit DEV_FALLBACK_OWNER is enabled.
  if (!user && process.env.NODE_ENV !== "production" && process.env.DEV_FALLBACK_OWNER === "true") {
    user = (await getUserByOpenId("owner_dev")) ?? {
      id: 1,
      openId: "owner_dev",
      name: "Sahil (Owner)",
      email: "owner@freelancehr.local",
      role: "admin",
      loginMethod: "local",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    actor: user,
    workspace: null,
  };
}
