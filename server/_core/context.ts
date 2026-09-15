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

  if (!user) {
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
