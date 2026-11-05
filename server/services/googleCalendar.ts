import {appendWorkflowEvent} from "./workflowStore";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { parse as parseCookies } from "cookie";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { googleCalendarConnections as connections, googleCalendarOAuthStates as states, googleCalendarEventBindings as bindings, interviews, clientDiscoveryMeetings, clientDiscoveryRequests, workflowEvents } from "../../drizzle/schema";
import { createId, requireDb, recordAudit } from "../db";
import { withWorkspaceTransaction, lockedSelect } from "./database";
import { isValidTimezone } from "../../shared/dateTime";
import { COOKIE_NAME } from "../../shared/const";
import { oidcSessionCookieNames } from "./runtimeAuth";

export const GOOGLE_CALENDAR_CALLBACK = "/api/integrations/google-calendar/callback";
export const GOOGLE_CALENDAR_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.owned"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const present = (value?: string) => Boolean(value?.trim() && !/^(?:your[_ -]|replace[_ -]|dummy(?:[_ -]|$)|<)/i.test(value.trim()));
function config() {
  const missing = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"].filter(key => !present(process.env[key]));
  if (present(process.env.GOOGLE_CALENDAR_CLIENT_ID) && !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(process.env.GOOGLE_CALENDAR_CLIENT_ID!.trim())) missing.push("GOOGLE_CALENDAR_CLIENT_ID (Web OAuth client)");
  if (!(process.env.SESSION_SECRET || process.env.JWT_SECRET) || (process.env.SESSION_SECRET || process.env.JWT_SECRET)!.trim().length < 32) missing.push("SESSION_SECRET (32+ characters)");
  let callback = "";
  try { const base = new URL(process.env.APP_BASE_URL || ""); if (base.protocol !== "https:") throw Error(); callback = base.origin + GOOGLE_CALENDAR_CALLBACK; } catch { missing.push("APP_BASE_URL (HTTPS)"); }
  if (process.env.GOOGLE_CALENDAR_REDIRECT_URI && process.env.GOOGLE_CALENDAR_REDIRECT_URI !== callback) missing.push("GOOGLE_CALENDAR_REDIRECT_URI (must match application callback)");
  return { missing, callback, clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() || "", clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || "" };
}
function requireConfig() { const c = config(); if (c.missing.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Calendar OAuth needs: ${c.missing.join(", ")}. An API key alone cannot authorize private calendars.` }); return c; }
function encryptionKey() { return Buffer.from(hkdfSync("sha256", (process.env.SESSION_SECRET || process.env.JWT_SECRET || "").trim(), "freehr-google-calendar-v1", "encrypted-provider-tokens", 32)); }
export function encryptCalendarSecret(value: unknown, context = "") { requireConfig(); const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv); cipher.setAAD(Buffer.from(context)); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join("."); }
export function decryptCalendarSecret<T>(value: string, context = ""): T { try { requireConfig(); const [version, iv, tag, data] = value.split("."); if (version !== "v1" || !data) throw Error(); const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url")); decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, "base64url")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString()); } catch { throw new CalendarFailure("reauthorization_required"); } }
class CalendarFailure extends TRPCError { constructor(public readonly reason: string) { super({ code: reason === "rate_limited" ? "TOO_MANY_REQUESTS" : /changed|conflict|superseded|in_progress/.test(reason) ? "CONFLICT" : /authorization|not_connected|scopes|identity/.test(reason) ? "PRECONDITION_FAILED" : "BAD_GATEWAY", message: `Google Calendar: ${reason.replaceAll("_", " ")}.` }); } }
function sessionHash(header?: string) { const cookies = parseCookies(header || ""), value = cookies[oidcSessionCookieNames.session] || cookies[COOKIE_NAME]; if (!value) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in before connecting a calendar." }); return hash(value); }
async function connection(tx: any, ownerId: number) { const row = (await lockedSelect(tx.select().from(connections).where(eq(connections.ownerId, ownerId)).limit(1)))[0]; return row ? { ...row } as typeof connections.$inferSelect : undefined; }
export async function googleCalendarStatus(ownerId: number) { const row = await connection(await requireDb(), ownerId), c = config(); return { configured: c.missing.length === 0, missing: c.missing, callbackUrl: c.callback, connected: row?.status === "active", status: row?.status || "disconnected", calendarId: row?.calendarId || "primary", accountEmail: row?.accountEmail || null, revision: row?.revision ?? 0, lastErrorCode: row?.lastErrorCode || null, scopes: GOOGLE_CALENDAR_SCOPES, mode: "owner_review_no_invitations" }; }
export async function beginGoogleCalendar(ownerId: number, cookieHeader?: string) {
  const c = requireConfig(), boundSession = sessionHash(cookieHeader), state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  await withWorkspaceTransaction(ownerId, async tx => {
    let row = await connection(tx, ownerId);
    if (!row) { const id = createId("gcal_"); await tx.insert(connections).values({ id, ownerId, status: "disconnected", revision: 1, calendarId: "primary" }); row = (await connection(tx, ownerId))!; }
    const revision = (row.revision ?? 1) + 1;
    await tx.update(connections).set({ revision, leaseToken: null, leaseUntil: null }).where(eq(connections.id, row.id));
    await tx.update(states).set({ consumedAt: new Date(), verifierCipher: null }).where(eq(states.ownerId, ownerId));
    await tx.insert(states).values({ id: hash(state), ownerId, connectionId: row.id, revision, sessionHash: boundSession, verifierCipher: encryptCalendarSecret(verifier, `state:${ownerId}:${row.id}:${revision}`), expiresAt: new Date(Date.now() + 600000), consumedAt: null });
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.callback, response_type: "code", scope: GOOGLE_CALENDAR_SCOPES.join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
  return { authorizationUrl: url.toString() };
}
async function request(url: string, init: RequestInit = {}, allowed: number[] = []) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const body = await response.arrayBuffer();
    if (body.byteLength > 1024 * 1024) throw new CalendarFailure("provider_response_too_large");
    if (!response.ok && !allowed.includes(response.status)) {
      let reasons: string[] = [];
      try { const payload = JSON.parse(Buffer.from(body).toString()); reasons = [payload.error, ...(payload.error?.errors ?? []).map((e: any) => e.reason)].filter((v: unknown) => typeof v === "string"); } catch { /* Never expose provider error bodies. */ }
      if (response.status === 429 || reasons.some(r => ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(r))) throw new CalendarFailure("rate_limited");
      if (reasons.includes("accessNotConfigured")) throw new CalendarFailure("calendar_api_not_enabled");
      if (reasons.includes("invalid_client")) throw new CalendarFailure("oauth_client_configuration_invalid");
      throw new CalendarFailure([401, 403].includes(response.status) || reasons.includes("invalid_grant") ? "authorization_failed" : "provider_unavailable");
    }
    return new Response(body.byteLength ? body : null, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") || "application/json" } });
  } catch (e) { if (e instanceof CalendarFailure) throw e; throw new CalendarFailure("provider_unavailable"); }
  finally { clearTimeout(timeout); }
}

type Tokens = { access: string; refresh: string; expiresAt: number };
function tokens(payload: any, previousRefresh?: string): Tokens {
  const refresh = payload.refresh_token || previousRefresh;
  if (String(payload.token_type).toLowerCase() !== "bearer" || typeof payload.access_token !== "string" || !payload.access_token || typeof refresh !== "string" || !refresh || !Number.isFinite(Number(payload.expires_in)) || Number(payload.expires_in) <= 0 || Number(payload.expires_in) > 86400) throw new CalendarFailure("offline_authorization_required");
  return { access: payload.access_token, refresh, expiresAt: Date.now() + Number(payload.expires_in) * 1000 };
}
export async function completeGoogleCalendar(ownerId: number, cookieHeader: string | undefined, state: string, code: string) {
  const c = requireConfig(), boundSession = sessionHash(cookieHeader);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096) throw new CalendarFailure("invalid_authorization_state");
  const claimed = await withWorkspaceTransaction(ownerId, async tx => {
    const row = (await lockedSelect(tx.select().from(states).where(eq(states.id, hash(state))).limit(1)))[0];
    if (!row || row.ownerId !== ownerId || row.sessionHash !== boundSession || row.consumedAt || new Date(row.expiresAt).getTime() <= Date.now() || !row.verifierCipher) throw new CalendarFailure("invalid_authorization_state");
    const current = await connection(tx, ownerId); if (!current || current.revision !== row.revision) throw new CalendarFailure("superseded_authorization");
    const verifier = decryptCalendarSecret<string>(row.verifierCipher, `state:${ownerId}:${row.connectionId}:${row.revision}`);
    await tx.update(states).set({ consumedAt: new Date(), verifierCipher: null }).where(eq(states.id, row.id));
    return { connectionId: row.connectionId as string, revision: row.revision as number, verifier };
  });
  try {
    const exchange = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.callback, code_verifier: claimed.verifier, grant_type: "authorization_code" }) });
    const payload = await exchange.json() as any, credential = tokens(payload), scopes = String(payload.scope || "").split(" ");
    if (!GOOGLE_CALENDAR_SCOPES.filter(scope => scope.startsWith("https:")).every(scope => scopes.includes(scope))) throw new CalendarFailure("required_scopes_missing");
    const identity = await (await request("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${credential.access}` } })).json() as any;
    if (typeof identity.sub !== "string" || typeof identity.email !== "string" || identity.email_verified !== true) throw new CalendarFailure("account_identity_unverified");
    await withWorkspaceTransaction(ownerId, async tx => {
      const row = await connection(tx, ownerId); if (!row || row.id !== claimed.connectionId || row.revision !== claimed.revision) throw new CalendarFailure("superseded_authorization");
      await tx.update(connections).set({ status: "active", revision: row.revision + 1, tokensCipher: encryptCalendarSecret(credential, `tokens:${ownerId}:${row.id}:${hash(identity.sub)}`), accountHash: hash(identity.sub), accountEmail: identity.email, scopes, leaseToken: null, leaseUntil: null, lastErrorCode: null }).where(eq(connections.id, row.id));
      await recordAudit({ ownerId, actorType: "user", actorId: String(ownerId), action: "google_calendar.connected", resourceType: "integration", resourceId: row.id }, tx);
    });
  } catch (e) {
    const reason = e instanceof CalendarFailure ? e.reason : "authorization_completion_failed";
    await withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (current?.id === claimed.connectionId && current.revision === claimed.revision) await tx.update(connections).set({ lastErrorCode: reason }).where(eq(connections.id, current.id)); });
    throw e;
  }
}
async function withCalendar<T>(ownerId: number, run: (row: typeof connections.$inferSelect, access: string, guard: () => Promise<void>) => Promise<T>) {
  const c = requireConfig(), lease = createId("glease_");
  const row = await withWorkspaceTransaction(ownerId, async tx => {
    const row = await connection(tx, ownerId); if (!row || row.status !== "active" || !row.tokensCipher) throw new CalendarFailure("calendar_not_connected");
    if (row.leaseToken && row.leaseUntil && new Date(row.leaseUntil).getTime() > Date.now()) throw new CalendarFailure("calendar_request_in_progress");
    await tx.update(connections).set({ leaseToken: lease, leaseUntil: new Date(Date.now() + 90000) }).where(eq(connections.id, row.id)); return { ...row, leaseToken: lease, leaseUntil: new Date(Date.now() + 90000) };
  });
  const guard = async () => withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (!current || current.status !== "active" || current.revision !== row.revision || current.leaseToken !== lease || !current.leaseUntil || new Date(current.leaseUntil).getTime() <= Date.now()) throw new CalendarFailure("connection_changed"); });
  try {
    let credential = decryptCalendarSecret<Tokens>(row.tokensCipher!, `tokens:${ownerId}:${row.id}:${row.accountHash}`);
    if (credential.expiresAt < Date.now() + 60000) {
      const refreshed = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: credential.refresh }) });
      credential = tokens(await refreshed.json(), credential.refresh); await guard();
      await withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (current?.leaseToken !== lease || current.revision !== row.revision) throw new CalendarFailure("connection_changed"); await tx.update(connections).set({ tokensCipher: encryptCalendarSecret(credential, `tokens:${ownerId}:${row.id}:${row.accountHash}`) }).where(eq(connections.id, row.id)); });
    }
    await guard(); const result = await run(row, credential.access, guard);
    await withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (current?.leaseToken === lease && current.revision === row.revision) await tx.update(connections).set({ lastErrorCode: null }).where(eq(connections.id, row.id)); });
    return result;
  } catch (e) {
    const reason = e instanceof CalendarFailure ? e.reason : e instanceof TRPCError ? "request_conflict" : "provider_unavailable";
    await withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (current?.leaseToken === lease && current.revision === row.revision) await tx.update(connections).set({ lastErrorCode: reason, ...(["authorization_failed", "reauthorization_required"].includes(reason) ? { status: "needs_reconnect", tokensCipher: null, revision: current.revision + 1 } : {}) }).where(eq(connections.id, row.id)); });
    throw e instanceof CalendarFailure || e instanceof TRPCError ? e : new CalendarFailure(reason);
  } finally { await withWorkspaceTransaction(ownerId, async tx => { const current = await connection(tx, ownerId); if (current?.leaseToken === lease) await tx.update(connections).set({ leaseToken: null, leaseUntil: null }).where(eq(connections.id, row.id)); }); }
}
async function providerBusy(row: typeof connections.$inferSelect, access: string, start: Date, end: Date) {
  const response = await request("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: row.calendarId }] }) });
  const data = await response.json() as any, calendar = data.calendars?.[row.calendarId];
  if (!calendar || (calendar.errors !== undefined && (!Array.isArray(calendar.errors) || calendar.errors.length > 0)) || !Array.isArray(calendar.busy)) throw new CalendarFailure("calendar_unavailable");
  const busy: Array<{ start: Date; end: Date }> = calendar.busy.map((item: any) => ({ start: new Date(item.start), end: new Date(item.end) }));
  if (busy.some(b => !Number.isFinite(b.start.getTime()) || !Number.isFinite(b.end.getTime()) || b.end <= b.start)) throw new CalendarFailure("invalid_provider_response");
  return busy;
}
export async function googleFreeBusy(ownerId: number, start: Date, end: Date) {
  if (end <= start || end.getTime() - start.getTime() > 31 * 86400000) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an increasing window of at most 31 days." });
  return withCalendar(ownerId, async (row, access, guard) => {
    const busy = await providerBusy(row, access, start, end);
    await guard(); return { calendarId: row.calendarId, connectionRevision: row.revision, checkedAt: new Date(), busy, reservation: false };
  });
}
export async function configureGoogleCalendar(ownerId: number, calendarId: string, expectedRevision: number) {
  if (!calendarId.trim() || calendarId.length > 320 || /[\r\n]/.test(calendarId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a calendar ID, such as primary." });
  return withWorkspaceTransaction(ownerId, async tx => { const row = await connection(tx, ownerId); if (!row || row.revision !== expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "Calendar connection changed. Reload it." }); await tx.update(connections).set({ calendarId: calendarId.trim(), revision: row.revision + 1, leaseToken: null, leaseUntil: null }).where(eq(connections.id, row.id)); return { saved: true }; });
}
export async function disconnectGoogleCalendar(ownerId: number) {
  const old = await withWorkspaceTransaction(ownerId, async tx => { const row = await connection(tx, ownerId); await tx.update(states).set({ consumedAt: new Date(), verifierCipher: null }).where(eq(states.ownerId, ownerId)); if (!row) return null; await tx.update(connections).set({ status: "disconnected", revision: row.revision + 1, tokensCipher: null, accountEmail: null, accountHash: null, scopes: null, leaseToken: null, leaseUntil: null }).where(eq(connections.id, row.id)); await recordAudit({ ownerId, actorType: "user", actorId: String(ownerId), action: "google_calendar.disconnected", resourceType: "integration", resourceId: row.id }, tx); return row.tokensCipher ? { cipher: row.tokensCipher, context: `tokens:${ownerId}:${row.id}:${row.accountHash}` } : null; });
  let revocationConfirmed = !old;
  if (old) try { const credential = decryptCalendarSecret<Tokens>(old.cipher, old.context); const response = await request("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.refresh }) }, [400]); revocationConfirmed = response.status === 200 || (await response.json() as any).error === "invalid_token"; } catch { /* Local tokens are removed even if provider revocation fails. */ }
  return { disconnected: true, revocationConfirmed, eventsDeleted: false };
}
export async function googleInterviewSnapshot(tx: any, ownerId: number, id: string) {
  const row = await connection(tx, ownerId), interview = (await tx.select().from(interviews).where(and(eq(interviews.ownerId, ownerId), eq(interviews.id, id))).limit(1))[0];
  if (!row || row.status !== "active" || !row.accountHash) throw new CalendarFailure("calendar_not_connected");
  if (!interview || !interview.scheduledAt) throw new TRPCError({ code: "NOT_FOUND", message: "A scheduled owned interview is required." });
  const start = new Date(interview.scheduledAt), duration = interview.durationMinutes ?? 45;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(duration) || duration < 1 || duration > 1440 || !isValidTimezone(interview.timezone || "UTC")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Review the saved interview time, duration and timezone before syncing." });
  const binding = hash(JSON.stringify([row.id, row.accountHash, row.calendarId, id]));
  const event = { summary: `FreelanceHR interview ${id.slice(-6)}`, location: interview.meetingUrl || "", start: { dateTime: new Date(interview.scheduledAt).toISOString(), timeZone: interview.timezone }, end: { dateTime: new Date(new Date(interview.scheduledAt).getTime() + (interview.durationMinutes ?? 45) * 60000).toISOString(), timeZone: interview.timezone }, status: interview.status === "cancelled" || interview.calendarStatus === "cancelled" ? "cancelled" : interview.calendarStatus === "confirmed" ? "confirmed" : "tentative", extendedProperties: { private: { freehrBinding: binding, freehrSequence: String(interview.calendarSequence ?? 0) } } };
  return { connection: row, binding, eventId: `fh${binding}`, interviewId: id, event, previewHash: hash(JSON.stringify([row.revision, binding, event])) };
}
type CalendarResource="interview"|"client_discovery";
export async function googleDiscoverySnapshot(tx:any,ownerId:number,id:string){
 const row=await connection(tx,ownerId),meeting=(await tx.select().from(clientDiscoveryMeetings).where(and(eq(clientDiscoveryMeetings.ownerId,ownerId),eq(clientDiscoveryMeetings.id,id))).limit(1))[0];
 if(!meeting)throw new TRPCError({code:"NOT_FOUND",message:"An owned client discovery meeting is required."});
 if(!row||row.status!=="active"||!row.accountHash)throw new CalendarFailure("calendar_not_connected");
 const requestRow=(await tx.select().from(clientDiscoveryRequests).where(and(eq(clientDiscoveryRequests.ownerId,ownerId),eq(clientDiscoveryRequests.id,meeting.requestId))).limit(1))[0];
 const start=new Date(meeting.scheduledAt);
 if(!requestRow||!["tentative","cancelled"].includes(meeting.status)||!Number.isFinite(start.getTime())||!Number.isInteger(meeting.durationMinutes)||meeting.durationMinutes<15||meeting.durationMinutes>120||!isValidTimezone(meeting.timezone))throw new TRPCError({code:"PRECONDITION_FAILED",message:"Review the saved client discovery meeting before syncing."});
 const binding=hash(JSON.stringify([row.id,row.accountHash,row.calendarId,"client_discovery",id]));
 const event={summary:`FreelanceHR discovery ${id.slice(-6)}`,location:"",visibility:"private",reminders:{useDefault:false},start:{dateTime:start.toISOString(),timeZone:meeting.timezone},end:{dateTime:new Date(start.getTime()+meeting.durationMinutes*60000).toISOString(),timeZone:meeting.timezone},status:meeting.status==="cancelled"?"cancelled":"tentative",extendedProperties:{private:{freehrBinding:binding,freehrSequence:String(meeting.revision),freehrResource:"client_discovery"}}};
 return {connection:row,binding,eventId:`fh${binding}`,meetingId:id,event,previewHash:hash(JSON.stringify([row.revision,binding,event]))};
}
type CalendarSnapshot=Pick<Awaited<ReturnType<typeof googleInterviewSnapshot>>,"connection"|"binding"|"eventId"|"event"|"previewHash">;
const resourceSnapshot=(tx:any,ownerId:number,id:string,resource:CalendarResource):Promise<CalendarSnapshot>=>resource==="client_discovery"?googleDiscoverySnapshot(tx,ownerId,id):googleInterviewSnapshot(tx,ownerId,id);
async function readResourceBinding(tx:any,ownerId:number,binding:string,resource:CalendarResource){
 if(resource==="interview")return (await tx.select().from(bindings).where(and(eq(bindings.ownerId,ownerId),eq(bindings.id,binding))).limit(1))[0];
 const event=(await tx.select().from(workflowEvents).where(and(eq(workflowEvents.ownerId,ownerId),eq(workflowEvents.eventType,"google_calendar.discovery_bound"),eq(workflowEvents.aggregateId,binding))).orderBy(desc(workflowEvents.revision)).limit(1))[0];
 return event?{...event.metadata,revision:event.revision}:undefined;
}
export async function previewGoogleDiscovery(ownerId:number,id:string){return withWorkspaceTransaction(ownerId,async tx=>{const s=await googleDiscoverySnapshot(tx,ownerId,id);return {meetingId:id,previewHash:s.previewHash,calendarId:s.connection.calendarId,accountEmail:s.connection.accountEmail,event:s.event,invitationsSent:false,mode:"owner_review"};});}
export async function syncGoogleDiscovery(ownerId:number,id:string,previewHash:string,automationGuard:()=>Promise<void>=async()=>{},execution:"manual"|"automatic"="manual",approvedExternalReviewHash?:string){return syncGoogleResource(ownerId,id,previewHash,automationGuard,execution,approvedExternalReviewHash,"client_discovery");}
export async function previewGoogleInterview(ownerId: number, id: string) { return withWorkspaceTransaction(ownerId, async tx => { const s = await googleInterviewSnapshot(tx, ownerId, id); return { interviewId: id, previewHash: s.previewHash, calendarId: s.connection.calendarId, accountEmail: s.connection.accountEmail, event: s.event, invitationsSent: false, mode: "owner_review" }; }); }
export async function syncGoogleInterview(ownerId: number, id: string, previewHash: string, automationGuard: () => Promise<void> = async () => {}, execution: "manual" | "automatic" = "manual", approvedExternalReviewHash?: string) { return syncGoogleResource(ownerId,id,previewHash,automationGuard,execution,approvedExternalReviewHash,"interview"); }
function sameOwnedEvent(expected:any,remote:any){return expected.summary===remote.summary&&(expected.location||"")===(remote.location||"")&&Date.parse(expected.start.dateTime)===Date.parse(remote.start?.dateTime)&&Date.parse(expected.end.dateTime)===Date.parse(remote.end?.dateTime)&&expected.status===remote.status&&expected.visibility===remote.visibility&&remote.reminders?.useDefault===false&&!(remote.reminders?.overrides?.length)&&expected.extendedProperties.private.freehrSequence===remote.extendedProperties?.private?.freehrSequence;}
async function syncGoogleResource(ownerId:number,id:string,previewHash:string,automationGuard:()=>Promise<void>,execution:"manual"|"automatic",approvedExternalReviewHash:string|undefined,resource:CalendarResource) {
  return withCalendar(ownerId, async (row, access, guard) => {
    await automationGuard();
    const s = await withWorkspaceTransaction(ownerId, tx => resourceSnapshot(tx, ownerId, id, resource));
    if (s.previewHash !== previewHash || s.connection.revision !== row.revision) throw new TRPCError({ code: "CONFLICT", message: resource==="interview"?"Interview or calendar changed. Review a fresh event preview.":"Discovery meeting or calendar changed. Review a fresh event preview." });
    await providerBusy(row, access, new Date(s.event.start.dateTime), new Date(s.event.end.dateTime));
    await guard();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendarId)}/events`, headers = { Authorization: `Bearer ${access}`, "Content-Type": "application/json" };
    const stillCurrent = async () => { await automationGuard(); await guard(); const current = await withWorkspaceTransaction(ownerId, tx => resourceSnapshot(tx, ownerId, id, resource)); if (current.previewHash !== previewHash) throw new CalendarFailure(resource==="interview"?"interview_changed":"meeting_changed"); };
    let remote = await request(`${url}/${s.eventId}`, { headers }, [404]);
    let data: any = remote.status === 404 ? null : await remote.json();
    if (data?.status === "cancelled" && s.event.status === "cancelled") { await stillCurrent(); return { synced: true, action: "already_cancelled", invitationsSent: false }; }
    if (data && data.extendedProperties?.private?.freehrBinding !== s.binding) throw new CalendarFailure("event_identity_conflict");
    await stillCurrent();
    if (!data && s.event.status === "cancelled") return { synced: true, action: "no_external_event", invitationsSent: false };
    if (!data) { remote = await request(`${url}?sendUpdates=none`, { method: "POST", headers, body: JSON.stringify({ ...s.event, id: s.eventId }) }, [409]); if (remote.status === 409) data = await (await request(`${url}/${s.eventId}`, { headers })).json(); else {data = await remote.json();
      if(resource==="client_discovery"&&data?.id===s.eventId&&data.extendedProperties?.private?.freehrBinding===s.binding&&typeof data.etag==="string"&&data.etag.length<=512){
        await withWorkspaceTransaction(ownerId,async tx=>{const current=await connection(tx,ownerId);if(current?.leaseToken!==row.leaseToken||current.revision!==row.revision)throw new CalendarFailure("connection_changed");const latest=await googleDiscoverySnapshot(tx,ownerId,id),prior=await readResourceBinding(tx,ownerId,s.binding,resource);await appendWorkflowEvent(tx,ownerId,"google_calendar.discovery_bound",s.binding,(prior?.revision??0)+1,{connectionId:row.id,meetingId:id,eventId:s.eventId,syncedFingerprint:previewHash,providerEtag:data.etag,lastSyncedAt:new Date().toISOString(),lastErrorCode:latest.previewHash===previewHash?null:"meeting_changed_after_creation",observation:"creation_accepted"});});
      }
    } }
    if (data?.extendedProperties?.private?.freehrBinding !== s.binding || (typeof data?.etag !== "string" || !data.etag || data.etag.length > 512)) throw new CalendarFailure("event_identity_conflict");
    const previousBinding = await withWorkspaceTransaction(ownerId, async tx =>
      readResourceBinding(tx,ownerId,s.binding,resource));
    if (approvedExternalReviewHash && (execution !== "manual" || approvedExternalReviewHash !== externalReviewKey(s.previewHash, data))) throw new CalendarFailure("external_review_changed");
    if(resource==="client_discovery"&&!previousBinding?.providerEtag&&!approvedExternalReviewHash&&!sameOwnedEvent(s.event,data))throw new CalendarFailure("external_event_changed");
    if (previousBinding?.providerEtag && previousBinding.providerEtag !== data.etag && !approvedExternalReviewHash) throw new CalendarFailure("external_event_changed");
    await stillCurrent();
    const patched = await request(`${url}/${s.eventId}?sendUpdates=none`, { method: "PATCH", headers: { ...headers, "If-Match": data.etag }, body: JSON.stringify(s.event) }, [412]);
    if (patched.status === 412) throw new CalendarFailure("external_event_changed");
    const saved = await patched.json() as any;
    if (saved.id !== s.eventId || (s.event.status === "cancelled" ? saved.status !== "cancelled" : saved.extendedProperties?.private?.freehrBinding !== s.binding || typeof saved.etag !== "string" || saved.etag.length > 512)) throw new CalendarFailure("invalid_provider_response");
    await automationGuard();
    const currentAfterWrite = await withWorkspaceTransaction(ownerId, async tx => {
      const current = await connection(tx, ownerId), latest = await resourceSnapshot(tx, ownerId, id, resource);
      if (current?.leaseToken !== row.leaseToken || current?.revision !== row.revision || !current?.leaseUntil || new Date(current.leaseUntil).getTime() <= Date.now()) throw new CalendarFailure("connection_changed");
      const values = { ownerId, connectionId: row.id, interviewId: id, eventId: s.eventId, syncedFingerprint: previewHash, providerEtag: saved.etag || null, lastSyncedAt: new Date(), lastErrorCode: latest.previewHash === previewHash ? null : "interview_changed_after_write" };
      if(resource==="interview"){
        const prior = (await tx.select().from(bindings).where(eq(bindings.id, s.binding)).limit(1))[0];
        if (prior) await tx.update(bindings).set(values).where(eq(bindings.id, s.binding)); else await tx.insert(bindings).values({ id: s.binding, ...values });
      }else{
        const prior=await readResourceBinding(tx,ownerId,s.binding,resource);
        await appendWorkflowEvent(tx,ownerId,"google_calendar.discovery_bound",s.binding,(prior?.revision??0)+1,{connectionId:row.id,meetingId:id,eventId:s.eventId,syncedFingerprint:previewHash,providerEtag:saved.etag||null,lastSyncedAt:new Date().toISOString(),lastErrorCode:latest.previewHash===previewHash?null:"meeting_changed_after_write"});
      }
      await recordAudit({ ownerId, actorType: execution === "automatic" ? "system" : "user", actorId: execution === "automatic" ? undefined : String(ownerId), action: "google_calendar.event_synced", resourceType: resource, resourceId: id, metadata: { execution, externalChangeReviewed: Boolean(approvedExternalReviewHash), current: latest.previewHash === previewHash, invitationsSent: false } }, tx);
      return latest.previewHash === previewHash;
    });
    if (!currentAfterWrite) throw new CalendarFailure(resource==="interview"?"interview_changed_after_write":"meeting_changed_after_write");
    return { synced: true, action: "upserted", invitationsSent: false };
  });
}

function externalReviewKey(previewHash: string, remote: any) { return hash(JSON.stringify([previewHash, remote.id, remote.etag])); }
export async function reviewGoogleConflict(ownerId:number,id:string){return reviewResourceConflict(ownerId,id,"interview");}
export async function reviewGoogleDiscoveryConflict(ownerId:number,id:string){return reviewResourceConflict(ownerId,id,"client_discovery");}
async function reviewResourceConflict(ownerId:number,id:string,resource:CalendarResource) {
  return withCalendar(ownerId, async (row, access, guard) => {
    const s = await withWorkspaceTransaction(ownerId, tx => resourceSnapshot(tx, ownerId, id, resource));
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendarId)}/events/${s.eventId}`;
    const remote = await (await request(url, { headers: { Authorization: `Bearer ${access}` } })).json() as any;
    if (remote.id !== s.eventId || remote.extendedProperties?.private?.freehrBinding !== s.binding || typeof remote.etag !== "string" || remote.etag.length > 512) throw new CalendarFailure("event_identity_conflict");
    await guard();
    const latest = await withWorkspaceTransaction(ownerId, tx => resourceSnapshot(tx, ownerId, id, resource));
    if (latest.previewHash !== s.previewHash) throw new CalendarFailure(resource==="interview"?"interview_changed":"meeting_changed");
    return { previewHash: s.previewHash, approvedExternalReviewHash: externalReviewKey(s.previewHash, remote), saved: s.event,
      remote: { summary: String(remote.summary || "").slice(0,1000), status: String(remote.status || ""), start: String(remote.start?.dateTime || remote.start?.date || ""), end: String(remote.end?.dateTime || remote.end?.date || ""), location: String(remote.location || "").slice(0,1000), ...(resource==="client_discovery"?{visibility:String(remote.visibility||"default"),attendeeCount:Array.isArray(remote.attendees)?remote.attendees.length:0,remindersEnabled:Boolean(remote.reminders?.useDefault||remote.reminders?.overrides?.length)}:{}) } };
  });
}

/** Bounded proposals may add buffers to a 31-day window; keep each provider request within its limit. */
export async function googleFreeBusyWithBuffers(ownerId:number,start:Date,end:Date){
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start||end.getTime()-start.getTime()>32*86400000)throw new TRPCError({code:'BAD_REQUEST',message:'Invalid buffered availability window.'});
 let cursor=start.getTime(),combined:Awaited<ReturnType<typeof googleFreeBusy>>|undefined;
 while(cursor<end.getTime()){
  const until=Math.min(end.getTime(),cursor+31*86400000),part=await googleFreeBusy(ownerId,new Date(cursor),new Date(until));
  if(combined&&(combined.connectionRevision!==part.connectionRevision||combined.calendarId!==part.calendarId))throw new TRPCError({code:'CONFLICT',message:'Calendar changed during the availability check.'});
  combined=combined?{...combined,busy:[...combined.busy,...part.busy],checkedAt:new Date(Math.min(new Date(combined.checkedAt).getTime(),new Date(part.checkedAt).getTime()))}:part;cursor=until;
 }
 return combined!;
}
