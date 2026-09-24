import "dotenv/config";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, or } from "drizzle-orm";
import { appRouter } from "./routers";
import { candidateDocuments, workspaceSettings, type User } from "../drizzle/schema";
import { requireDb, verifyDatabaseConnectivity } from "./db";
import { sdk } from "./_core/sdk";
import { processHostingerMailWebhook } from "./services/hostingerWebhook";
import { processDueInterviewReminders } from "./services/interviewReminders";
import { processDueAutomationBatch } from "./services/queue";
import { getPrivateStorageStatus, readPrivateDocument } from "./services/privateStorage";
import {
  assertProductionRuntimeConfiguration,
  authenticateCronRequest,
  authenticateRuntimeRequest,
  beginOidcLogin,
  completeOidcLogin,
  isOidcRuntime,
} from "./services/runtimeAuth";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(currentDir, "public");

async function createFastifyContext({ req, res }: { req: { raw: unknown }; res: { raw: unknown } }) {
  const user: User | null = await authenticateRuntimeRequest(req.raw as { headers?: { cookie?: string } });
  return { req: req.raw, res: res.raw, user, actor: user, workspace: null } as never;
}

export interface FastifyServerOptions {
  logger?: boolean;
}

export async function buildFastifyServer(options: FastifyServerOptions = {}) {
  assertProductionRuntimeConfiguration();
  const isStrictProduction = process.env.NODE_ENV === "production" && !process.env.VITEST;
  if (isStrictProduction) {
    await requireDb();
  }

  // Fastify default bodyLimit is 1 MB; previously set to 6 MB.
  // 5 MB binary files encoded as base64 inflate by ~33.3% (5 MB -> ~6.67 MB, up to 7,000,000 chars in zod schema).
  // Including the JSON body envelope, candidate metadata, and tRPC batch link wrapper, the HTTP payload
  // is typically ~7.2 MB - 7.5 MB.
  // A 10 MB (10 * 1024 * 1024 bytes) limit ensures near-5MB candidate document uploads are not prematurely rejected
  // by Fastify with HTTP 413, allowing them to reach the application-level 5 MB binary check in
  // candidates.documents.upload, while still protecting the server against unbounded memory consumption.
  const app: FastifyInstance = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: process.env.APP_BASE_URL ?? false, credentials: true });
  await app.register(fastifyTRPCPlugin, {
    prefix: "/api/trpc",
    trpcOptions: { router: appRouter, createContext: createFastifyContext },
  });

  if (isOidcRuntime()) {
    app.get("/api/auth/oidc/login", async (_request, reply) => {
      try {
        const login = await beginOidcLogin();
        reply.header("Set-Cookie", login.stateCookie);
        return reply.redirect(login.redirectUrl);
      } catch {
        return reply.status(503).send({ error: "OIDC sign-in is not configured." });
      }
    });
    app.get("/api/auth/oidc/callback", async (request, reply) => {
      try {
        const query = request.query as { code?: string; state?: string };
        const completed = await completeOidcLogin({
          code: query.code,
          state: query.state,
          cookieHeader: request.headers.cookie,
        });
        reply.header("Set-Cookie", [completed.sessionCookie, completed.clearStateCookie]);
        return reply.redirect("/");
      } catch {
        return reply.status(403).send({ error: "OIDC sign-in could not be completed." });
      }
    });
  }

  // 1. Private storage route (active only when PRIVATE_STORAGE_MODE resolves to "local")
  if (getPrivateStorageStatus().mode === "local") {
    app.get<{ Params: { "*": string } }>("/api/private-storage/*", async (request, reply) => {
      try {
        const user = await authenticateRuntimeRequest((request.raw || request) as any);
        if (!user) return reply.status(401).send({ error: "authentication-required" });
        const rawKey = request.params["*"] || "";
        const key = rawKey.startsWith("local/") ? rawKey.slice(6) : rawKey;
        const db = await requireDb();
        const document = (
          await db
            .select()
            .from(candidateDocuments)
            .where(eq(candidateDocuments.storageKey, `local/${key}`))
            .limit(1)
        )[0];
        if (!document || document.ownerId !== user.id) {
          return reply.status(404).send({ error: "document-not-found" });
        }
        if (document.scanState !== "clean") {
          return reply.status(403).send({
            error: document.scanState === "flagged" ? "document-flagged" : "document-scan-pending",
            message:
              document.scanState === "flagged"
                ? "Document was flagged during security scanning and cannot be accessed."
                : "Document is pending security scanning and cannot be accessed yet.",
          });
        }
        const bytes = await readPrivateDocument(document.storageKey);
        reply.header("Content-Type", document.mimeType);
        reply.header("Content-Disposition", "inline");
        return reply.send(bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Private document read failed.";
        return reply.status(404).send({ error: message });
      }
    });
  }

  // 2. Scheduled interview reminders route with cron-only guard
  app.post("/api/scheduled/interview-reminders", async (request, reply) => {
    try {
      const cronUser = authenticateCronRequest(request);
      let user: { isCron?: boolean; taskUid?: string | null } | null = cronUser;
      if (!user) {
        if (process.env.NODE_ENV === "production") {
          return reply.status(401).send({ error: "cron-authentication-required" });
        }
        user = await sdk.authenticateRequest((request.raw || request) as any);
      }
      if (!user || !user.isCron || !user.taskUid) return reply.status(403).send({ error: "cron-only" });
      const db = await requireDb();
      const workspace = (
        await db
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.scheduleCronTaskUid, user.taskUid))
          .limit(1)
      )[0];
      if (!workspace) {
        if (user.taskUid === "global" || user.taskUid === "all") {
          const result = await processDueInterviewReminders(undefined, 10);
          return reply.send({ ok: true, ...result });
        }
        return reply.send({ ok: true, skipped: "orphan" });
      }
      const result = await processDueInterviewReminders(workspace.ownerId, 10);
      return reply.send({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduled reminder error.";
      return reply.status(500).send({ error: message, timestamp: new Date().toISOString() });
    }
  });

  // 3. Scheduled automation queue route with cron-only guard
  app.post("/api/scheduled/automation-queue", async (request, reply) => {
    try {
      const cronUser = authenticateCronRequest(request);
      let user: { isCron?: boolean; taskUid?: string | null } | null = cronUser;
      if (!user) {
        if (process.env.NODE_ENV === "production") {
          return reply.status(401).send({ error: "cron-authentication-required" });
        }
        user = await sdk.authenticateRequest((request.raw || request) as any);
      }
      if (!user || !user.isCron || !user.taskUid) return reply.status(403).send({ error: "cron-only" });
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
      const queryLimit = (request.query as any)?.limit;
      const bodyLimit = (request.body as any)?.limit;
      const batchLimit = Math.min(Math.max(Number(queryLimit ?? bodyLimit ?? 5), 1), 25);
      if (!workspace) {
        if (user.taskUid === "global" || user.taskUid === "all") {
          const result = await processDueAutomationBatch(undefined, batchLimit);
          return reply.send({ ok: true, ...result });
        }
        return reply.send({ ok: true, skipped: "orphan" });
      }
      const result = await processDueAutomationBatch(workspace.ownerId, batchLimit);
      return reply.send({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scheduled automation queue error.";
      return reply.status(500).send({ error: message, timestamp: new Date().toISOString() });
    }
  });

  app.post("/api/webhooks/hostinger-mail", async (request, reply) => {
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    const result = await processHostingerMailWebhook({ authorization, body: request.body });
    return reply.status(result.statusCode).send(result.body);
  });

  app.get("/api/health", async () => ({ status: "ok", service: "freelancehr", now: new Date().toISOString() }));

  await app.register(fastifyStatic, { root: staticRoot, wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
    return reply.type("text/html").sendFile("index.html");
  });

  return app;
}

async function start() {
  const isStrictProduction = process.env.NODE_ENV === "production" && !process.env.VITEST;
  if (isStrictProduction) {
    const dbCheck = await verifyDatabaseConnectivity();
    if (!dbCheck.connected) {
      console.error("[FreelanceHR] FATAL: Database connectivity check failed during startup:", dbCheck.error);
      process.exit(1);
    }
  }
  const app = await buildFastifyServer({ logger: true });
  const rawPort = process.env.PORT ? Number(process.env.PORT) : 3000;
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3000;
  await app.listen({ port, host: "0.0.0.0" });
}

// Start server when executed directly
const isDirectRun = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
if (isDirectRun) {
  start().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
