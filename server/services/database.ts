import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { ensureWorkspace, requireDb } from "../db";

export async function lockedSelect(query: any) {
  // Real Drizzle queries acquire row locks; the in-memory test adapter has no SQL lock API.
  return typeof query.for === "function" ? query.for("update") : query;
}

export async function withWorkspaceTransaction<T>(ownerId: number, command: (tx: any) => Promise<T>): Promise<T> {
  await ensureWorkspace(ownerId);
  return (await requireDb()).transaction(async (tx: any) => {
    await lockedSelect(tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1));
    return command(tx);
  });
}
