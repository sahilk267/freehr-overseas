import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import { getUserByOpenId, upsertUser } from "../db";
import { getPrivateStorageStatus } from "./privateStorage";
import { canUseApplication } from "./workspaceAccess";
import { getConfiguredPrimaryOwner } from "./primaryOwner";
import { sdk } from "../_core/sdk";

const SESSION_COOKIE = "__Host-fh_session";
const STATE_COOKIE = "__Host-fh_oidc_state";
const SESSION_DURATION_SECONDS = 60 * 60 * 8;

type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
};

type OidcConfig = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  appBaseUrl: string;
  redirectUri: string;
  sessionSecret: string;
};

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function parseCookies(header?: string) {
  return Object.fromEntries((header ?? "").split(";").map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf("=");
    return index === -1 ? [value, ""] : [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
  }));
}

function sessionCookie(value: string, maxAge: number) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function stateCookie(value: string, maxAge: number) {
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function emptyCookie(name: string) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function configIssues() {
  const configuredOwner = getConfiguredPrimaryOwner();
  const values = {
    authMode: process.env.AUTH_MODE === "oidc",
    issuer: process.env.OIDC_ISSUER_URL?.trim(),
    clientId: process.env.OIDC_CLIENT_ID?.trim(),
    clientSecret: process.env.OIDC_CLIENT_SECRET?.trim(),
    appBaseUrl: process.env.APP_BASE_URL?.trim(),
    sessionSecret: process.env.SESSION_SECRET?.trim(),
    primaryOwner: configuredOwner.openId || configuredOwner.email,
  };
  const missing = [
    !values.authMode ? "AUTH_MODE=oidc" : null,
    !values.issuer ? "OIDC_ISSUER_URL" : null,
    !values.clientId ? "OIDC_CLIENT_ID" : null,
    !values.clientSecret ? "OIDC_CLIENT_SECRET" : null,
    !values.appBaseUrl ? "APP_BASE_URL" : null,
    !values.sessionSecret || values.sessionSecret.length < 32 ? "SESSION_SECRET (at least 32 characters)" : null,
    !values.primaryOwner ? "PRIMARY_OWNER_OPEN_ID or PRIMARY_OWNER_EMAIL" : null,
  ].filter((value): value is string => Boolean(value));
  return missing;
}

function getOidcConfig(): OidcConfig {
  const missing = configIssues();
  if (missing.length) throw new Error(`OIDC configuration is incomplete: ${missing.join(", ")}.`);
  const issuerUrl = process.env.OIDC_ISSUER_URL!.replace(/\/+$/, "");
  const appBaseUrl = process.env.APP_BASE_URL!.replace(/\/+$/, "");
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() || `${appBaseUrl}/api/auth/oidc/callback`;
  for (const value of [issuerUrl, appBaseUrl, redirectUri]) {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("OIDC issuer, app base URL, and callback must use HTTPS in production.");
  }
  return { issuerUrl, appBaseUrl, redirectUri, clientId: process.env.OIDC_CLIENT_ID!, clientSecret: process.env.OIDC_CLIENT_SECRET!, sessionSecret: process.env.SESSION_SECRET! };
}

async function discover(config: OidcConfig): Promise<OidcDiscovery> {
  const response = await fetch(`${config.issuerUrl}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("OIDC discovery endpoint did not return a usable configuration.");
  const discovery = await response.json() as OidcDiscovery;
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri || !discovery.issuer) throw new Error("OIDC discovery response is missing a required endpoint.");
  return discovery;
}

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function stableOpenId(issuer: string, subject: string) {
  return `oidc_${createHash("sha256").update(`${issuer}|${subject}`).digest("hex").slice(0, 52)}`;
}

async function signSession(openId: string, secret: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(openId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

export function isOidcRuntime() {
  return process.env.AUTH_MODE === "oidc";
}

export function getRuntimeLogoutCookie() {
  return isOidcRuntime() ? emptyCookie(SESSION_COOKIE) : null;
}

export function getProductionRuntimeStatus() {
  const storage = getPrivateStorageStatus();
  const oidcMissing = configIssues();
  return { oidcConfigured: oidcMissing.length === 0, oidcMissing, privateStorage: storage, configured: oidcMissing.length === 0 && storage.configured };
}

export function assertProductionRuntimeConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  const status = getProductionRuntimeStatus();
  const missing = [...status.oidcMissing, ...status.privateStorage.missing.map(value => `private storage ${value}`)];
  if (missing.length || !status.privateStorage.configured) {
    throw new Error(`production startup blocked: ${missing.join(", ")}.`);
  }
}

export async function beginOidcLogin() {
  const config = getOidcConfig();
  const discovery = await discover(config);
  const state = base64Url(randomBytes(32));
  const nonce = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(48));
  const statePayload = base64Url(Buffer.from(JSON.stringify({ state, nonce, verifier }), "utf8"));
  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", "openid profile email");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", sha256Base64Url(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return { redirectUrl: authorizationUrl.toString(), stateCookie: stateCookie(statePayload, 600) };
}

export async function completeOidcLogin(input: { code?: string; state?: string; cookieHeader?: string }) {
  if (!input.code || !input.state) throw new Error("OIDC response is incomplete.");
  const config = getOidcConfig();
  const stored = parseCookies(input.cookieHeader)[STATE_COOKIE];
  if (!stored) throw new Error("OIDC login state is unavailable or expired.");
  let statePayload: { state: string; nonce: string; verifier: string };
  try { statePayload = JSON.parse(Buffer.from(stored, "base64url").toString("utf8")); }
  catch { throw new Error("OIDC login state is invalid."); }
  if (!statePayload.state || statePayload.state !== input.state || !statePayload.nonce || !statePayload.verifier) throw new Error("OIDC login state verification failed.");
  const discovery = await discover(config);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: config.redirectUri, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: statePayload.verifier }),
  });
  if (!tokenResponse.ok) throw new Error("OIDC token exchange failed.");
  const token = await tokenResponse.json() as { id_token?: string };
  if (!token.id_token) throw new Error("OIDC token response did not include an ID token.");
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(token.id_token, jwks, { issuer: discovery.issuer, audience: config.clientId });
  const claims = verified.payload;
  if (typeof claims.sub !== "string" || claims.nonce !== statePayload.nonce) throw new Error("OIDC identity token validation failed.");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  const name = typeof claims.name === "string" ? claims.name.slice(0, 160) : email;
  const openId = stableOpenId(discovery.issuer, claims.sub);
  if (!canUseApplication({ openId, email })) {
    throw new Error("FreelanceHR is currently in owner-only testing mode.");
  }
  await upsertUser({ openId, email, name, loginMethod: "oidc", lastSignedIn: new Date() });
  const user = await getUserByOpenId(openId);
  if (!user) throw new Error("OIDC user provisioning failed.");
  return { user, sessionCookie: sessionCookie(await signSession(openId, config.sessionSecret), SESSION_DURATION_SECONDS), clearStateCookie: emptyCookie(STATE_COOKIE) };
}

export async function authenticateRuntimeRequest(request: { headers?: { cookie?: string } }) : Promise<User | null> {
  if (!isOidcRuntime()) {
    try {
      const user = await sdk.authenticateRequest(request as Parameters<typeof sdk.authenticateRequest>[0]);
      return canUseApplication(user) ? user : null;
    }
    catch { return null; }
  }
  try {
    const config = getOidcConfig();
    const token = parseCookies(request.headers?.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const verified = await jwtVerify(token, new TextEncoder().encode(config.sessionSecret), { algorithms: ["HS256"] });
    if (typeof verified.payload.sub !== "string") return null;
    const user = await getUserByOpenId(verified.payload.sub);
    return user && canUseApplication(user) ? user : null;
  } catch { return null; }
}

export function registerRuntimeAuthRoutes(app: Express) {
  if (!isOidcRuntime()) {
    return import("../_core/oauth").then(({ registerOAuthRoutes }) => registerOAuthRoutes(app));
  }
  app.get("/api/auth/oidc/login", async (_req, res) => {
    try { const login = await beginOidcLogin(); res.setHeader("Set-Cookie", login.stateCookie); res.redirect(login.redirectUrl); }
    catch { res.status(503).json({ error: "OIDC sign-in is not configured." }); }
  });
  app.get("/api/auth/oidc/callback", async (req, res) => {
    try {
      const completed = await completeOidcLogin({ code: typeof req.query.code === "string" ? req.query.code : undefined, state: typeof req.query.state === "string" ? req.query.state : undefined, cookieHeader: req.headers.cookie });
      res.setHeader("Set-Cookie", [completed.sessionCookie, completed.clearStateCookie]);
      res.redirect("/");
    } catch { res.status(403).json({ error: "OIDC sign-in could not be completed." }); }
  });
}

export const oidcSessionCookieNames = { session: SESSION_COOKIE, state: STATE_COOKIE };
