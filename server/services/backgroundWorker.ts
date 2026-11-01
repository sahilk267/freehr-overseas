import { and, asc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { workspaceSettings } from "../../drizzle/schema";
import { ensureWorkspace, requireDb } from "../db";
import { withWorkspaceTransaction } from "./database";
import { processDueAutomationBatch } from "./queue";
import { processDueInterviewReminders } from "./interviewReminders";
import { processDueInvoiceCollections } from "./invoiceCollections";
import { appendWorkflowEvent } from "./workflowStore";

let runtimeLoopActive = false;
export async function backgroundWorkerStatus(ownerId: number) {
  await ensureWorkspace(ownerId);
  const row = (await (await requireDb()).select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
  return { enabled: row.backgroundEnabled === true, revision: row.backgroundRevision ?? 1, runtimeLoopActive,
    persistentDatabase: Boolean((await requireDb()).$client), emergencyStop: Boolean(row.emergencyStop),
    lastHeartbeatAt: row.backgroundLastHeartbeatAt ?? null, lastResult: row.backgroundLastResult ?? null, lastError: row.backgroundLastError ?? null,
    heartbeatRecent: Boolean(row.backgroundLastHeartbeatAt && Date.now() - new Date(row.backgroundLastHeartbeatAt).getTime() < 180_000),
  };
}

export async function configureBackgroundWorker(ownerId: number, actorId: number, enabled: boolean, expectedRevision?: number) {
  await withWorkspaceTransaction(ownerId, async tx => {
    const row = (await tx.select().from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId)).limit(1))[0];
    const revision = row.backgroundRevision ?? 1;
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Background settings changed; reload before changing processing." });
    if (Boolean(row.backgroundEnabled) === enabled) return;
    await tx.update(workspaceSettings).set({ backgroundEnabled: enabled, backgroundRevision: revision + 1, backgroundLastHeartbeatAt: null, backgroundLastError: null }).where(eq(workspaceSettings.ownerId, ownerId));
    await appendWorkflowEvent(tx, ownerId, enabled ? "automation.background_enabled" : "automation.background_disabled", `workspace:${ownerId}`, revision + 1, { actorId, mode: "managed_runtime", noExternalCronRegistered: true });
  });
  return backgroundWorkerStatus(ownerId);
}

/** The same sources and physical queue serve manual, managed and supervised workers. */
export async function runManagedAutomationCycle(limit = 5) {
  const db = await requireDb();
  const rows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.backgroundEnabled, true)).orderBy(asc(workspaceSettings.backgroundLastHeartbeatAt), asc(workspaceSettings.ownerId)).limit(25);
  const outcomes: Array<{ ownerId: number; status: string }> = [];
  for (const row of rows) {
    // Re-read so a disable/stop received while another workspace ran takes effect.
    const current = (await db.select().from(workspaceSettings).where(and(eq(workspaceSettings.ownerId, row.ownerId), eq(workspaceSettings.backgroundEnabled, true))).limit(1))[0];
    if (!current) continue;
    const now = new Date();
    await db.update(workspaceSettings).set({ backgroundLastHeartbeatAt: now }).where(eq(workspaceSettings.ownerId, row.ownerId));
    try {
      const stopped = Boolean(current.emergencyStop);
      const result = stopped ? { status: "emergency_stopped", processed: 0 } : {
        status: "polled",
        interviews: await processDueInterviewReminders(row.ownerId, Math.min(25, limit)),
        collections: await processDueInvoiceCollections(row.ownerId, Math.min(25, limit)),
        batch: await processDueAutomationBatch(row.ownerId, limit),
      };
      await db.update(workspaceSettings).set({ backgroundLastHeartbeatAt: new Date(), backgroundLastResult: result, backgroundLastError: null }).where(eq(workspaceSettings.ownerId, row.ownerId));
      outcomes.push({ ownerId: row.ownerId, status: stopped ? "emergency_stopped" : "polled" });
    } catch {
      await db.update(workspaceSettings).set({ backgroundLastHeartbeatAt: new Date(), backgroundLastError: "Background cycle failed. Check migrations and server diagnostics before retrying." }).where(eq(workspaceSettings.ownerId, row.ownerId));
      outcomes.push({ ownerId: row.ownerId, status: "failed" });
    }
  }
  return outcomes;
}

/** Single-flight polling only: deadlines and retry authority stay in MySQL. */
export function startWorkerPolling(runCycle: () => Promise<unknown>, intervalMs = 15_000, onError: () => void = () => {}) {
  let stopping = false, inFlight: Promise<unknown> | null = null;
  const tick = () => {
    if (stopping || inFlight) return;
    inFlight = Promise.resolve().then(runCycle).catch(onError).finally(() => { inFlight = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => { stopping = true; clearInterval(timer); await inFlight; };
}

export function startManagedBackgroundWorker() {
  if (runtimeLoopActive || process.env.NODE_ENV !== "production" || process.env.VITEST || !/^mysql:\/\//i.test(process.env.DATABASE_URL ?? "")) return async () => {};
  runtimeLoopActive = true;
  const stop = startWorkerPolling(() => runManagedAutomationCycle(5), 15_000, () => console.error("Managed automation poll failed; check database connectivity and migrations."));
  return async () => { await stop(); runtimeLoopActive = false; };
}
