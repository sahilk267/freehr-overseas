import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { assertProductionRuntimeConfiguration, authenticateRuntimeRequest, registerRuntimeAuthRoutes } from "../services/runtimeAuth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { processHostingerMailWebhook } from "../services/hostingerWebhook";
import { processDueInterviewReminders } from "../services/interviewReminders";
import { processDueAutomationBatch } from "../services/queue";
import { readPrivateDocument } from "../services/privateStorage";
import { sdk } from "./sdk";
import { eq, or } from "drizzle-orm";
import { candidateDocuments, workspaceSettings } from "../../drizzle/schema";
import { requireDb } from "../db";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  assertProductionRuntimeConfiguration();
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API health route FIRST
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  registerStorageProxy(app);
  await registerRuntimeAuthRoutes(app);
  app.post("/api/webhooks/hostinger-mail", async (req, res) => {
    const result = await processHostingerMailWebhook({ authorization: req.headers.authorization, body: req.body });
    res.status(result.statusCode).json(result.body);
  });
  app.get("/api/private-storage/:key(*)", async (req, res) => {
    try {
      const user = await authenticateRuntimeRequest(req);
      if (!user) return res.status(401).json({ error: "authentication-required" });
      const key = String(req.params.key || "");
      const db = await requireDb();
      const document = (await db.select().from(candidateDocuments).where(eq(candidateDocuments.storageKey, `local/${key}`)).limit(1))[0];
      if (!document || document.ownerId !== user.id) return res.status(404).json({ error: "document-not-found" });
      if (document.scanState !== "clean") {
        return res.status(403).json({
          error: document.scanState === "flagged" ? "document-flagged" : "document-scan-pending",
          message:
            document.scanState === "flagged"
              ? "Document was flagged during security scanning and cannot be accessed."
              : "Document is pending security scanning and cannot be accessed yet.",
        });
      }
      const bytes = await readPrivateDocument(document.storageKey);
      res.setHeader("Content-Type", document.mimeType);
      res.setHeader("Content-Disposition", "inline");
      return res.send(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Private document read failed.";
      return res.status(404).json({ error: message });
    }
  });
  app.post("/api/scheduled/interview-reminders", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
      const db = await requireDb();
      const workspace = (await db.select().from(workspaceSettings).where(eq(workspaceSettings.scheduleCronTaskUid, user.taskUid)).limit(1))[0];
      if (!workspace) return res.json({ ok: true, skipped: "orphan" });
      const result = await processDueInterviewReminders(workspace.ownerId, 10);
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduled reminder error.";
      return res.status(500).json({ error: message, timestamp: new Date().toISOString() });
    }
  });
  app.post("/api/scheduled/automation-queue", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
      const db = await requireDb();
      const workspace = (
        await db
          .select()
          .from(workspaceSettings)
          .where(
            or(
              eq(workspaceSettings.automationCronTaskUid, user.taskUid),
              eq(workspaceSettings.scheduleCronTaskUid, user.taskUid)
            )
          )
          .limit(1)
      )[0];
      const queryLimit = req.query?.limit;
      const bodyLimit = req.body?.limit;
      const batchLimit = Math.min(Math.max(Number(queryLimit ?? bodyLimit ?? 5), 1), 25);
      if (!workspace) {
        if (user.taskUid === "global" || user.taskUid === "all") {
          const result = await processDueAutomationBatch(undefined, batchLimit);
          return res.json({ ok: true, ...result });
        }
        return res.json({ ok: true, skipped: "orphan" });
      }
      const result = await processDueAutomationBatch(workspace.ownerId, batchLimit);
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduled automation queue error.";
      return res.status(500).json({ error: message, timestamp: new Date().toISOString() });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Unmatched API requests must always return JSON and never fall through to HTML SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({
      error: "Not Found",
      message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV !== "production") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = 3000;

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    console.log(`Server running on http://0.0.0.0:${port}/`);
    console.log(`Server running on http://localhost:${port}`);
  });
}

startServer().catch(console.error);
